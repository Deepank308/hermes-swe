import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  CreateSnapshotCommand,
  DeleteSnapshotCommand,
  DescribeSnapshotsCommand,
  waitUntilInstanceRunning,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import { config } from "./config.js";

const ec2 = config.dryRun ? null : new EC2Client({ region: config.awsRegion });

let dryRunCounter = 0;

interface LaunchParams {
  userData: string;
  tags: Record<string, string>;
  /** Per-repo AMI ID — overrides config.agentAmiId */
  amiId?: string;
  /** Per-repo instance type — overrides config.agentInstanceType */
  instanceType?: string;
}

interface LaunchResult {
  instanceId: string;
  privateIp: string;
}

export async function launchInstance(
  params: LaunchParams,
): Promise<LaunchResult> {
  if (config.dryRun) {
    dryRunCounter++;
    const instanceId = `i-dryrun-${dryRunCounter.toString().padStart(4, "0")}`;
    const privateIp = "127.0.0.1";
    console.log(`[ec2:launch] DRY RUN: Would launch instance with tags:`, params.tags);
    console.log(
      `[ec2:launch] DRY RUN: Using ${instanceId} @ ${privateIp} (local agent-service)`,
    );
    return { instanceId, privateIp };
  }

  const tagSpecs = Object.entries(params.tags).map(([Key, Value]) => ({
    Key,
    Value,
  }));

  const imageId = params.amiId || config.agentAmiId;
  const instanceType = params.instanceType || config.agentInstanceType;

  const resp = await ec2!.send(
    new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: instanceType as _InstanceType,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: config.subnetId,
      SecurityGroupIds: [config.agentSecurityGroupId],
      UserData: params.userData,
      ...(config.keyName && { KeyName: config.keyName }),
      ...(config.agentIamInstanceProfile && {
        IamInstanceProfile: { Name: config.agentIamInstanceProfile },
      }),
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: tagSpecs,
        },
      ],
    }),
  );

  const instanceId = resp.Instances?.[0]?.InstanceId;
  if (!instanceId) {
    throw new Error("RunInstances did not return an instance ID");
  }

  // Wait for "running" state (up to 5 min)
  await waitUntilInstanceRunning(
    { client: ec2!, maxWaitTime: config.instanceStartupTimeoutSeconds },
    { InstanceIds: [instanceId] },
  );

  // Re-describe to get private IP (VPC communication, no internet gateway needed)
  const desc = await ec2!.send(
    new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
  );
  const privateIp = desc.Reservations?.[0]?.Instances?.[0]?.PrivateIpAddress;
  if (!privateIp) {
    throw new Error(`Instance ${instanceId} has no private IP address`);
  }

  return { instanceId, privateIp };
}

/**
 * List all running/pending hermes agent instances (tagged Project=hermes, Name=hermes-*).
 * Excludes the orchestrator and bake instances.
 */
export async function listAgentInstances(): Promise<
  Array<{ instanceId: string; agentSessionId?: string; launchTime?: Date }>
> {
  if (config.dryRun) return [];

  const resp = await ec2!.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Project", Values: ["hermes"] },
        { Name: "tag-key", Values: ["agentSessionId"] },
        { Name: "instance-state-name", Values: ["running", "pending"] },
      ],
    }),
  );

  const instances: Array<{
    instanceId: string;
    agentSessionId?: string;
    launchTime?: Date;
  }> = [];
  for (const reservation of resp.Reservations ?? []) {
    for (const inst of reservation.Instances ?? []) {
      if (!inst.InstanceId) continue;
      const sessionTag = inst.Tags?.find(
        (t) => t.Key === "agentSessionId",
      )?.Value;
      instances.push({
        instanceId: inst.InstanceId,
        agentSessionId: sessionTag,
        launchTime: inst.LaunchTime,
      });
    }
  }
  return instances;
}

export async function terminateInstance(instanceId: string): Promise<void> {
  if (config.dryRun) {
    console.log(`[ec2:terminate] DRY RUN: Would terminate instance ${instanceId}`);
    return;
  }

  try {
    await ec2!.send(
      new TerminateInstancesCommand({ InstanceIds: [instanceId] }),
    );
    console.log(`[ec2:terminate] Terminated instance ${instanceId}`);
  } catch (err) {
    console.warn(
      `[ec2:terminate] Failed to terminate ${instanceId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Get the root EBS volume ID for an instance.
 */
export async function getRootVolumeId(
  instanceId: string,
): Promise<string | undefined> {
  if (config.dryRun) {
    console.log(`[ec2:snapshot] DRY RUN: Would get root volume for ${instanceId}`);
    return "vol-dryrun-0001";
  }

  try {
    const desc = await ec2!.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    const instance = desc.Reservations?.[0]?.Instances?.[0];
    if (!instance) return undefined;

    const rootDeviceName = instance.RootDeviceName;
    const rootMapping = instance.BlockDeviceMappings?.find(
      (m) => m.DeviceName === rootDeviceName,
    );
    return rootMapping?.Ebs?.VolumeId;
  } catch (err) {
    console.warn(
      `[ec2:snapshot] Failed to get root volume for ${instanceId}:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/**
 * Create an EBS snapshot of a volume, tagged with Project=hermes and an expiry date.
 */
export async function createSnapshot(
  volumeId: string,
  tags: Record<string, string>,
): Promise<string | undefined> {
  if (config.dryRun) {
    console.log(`[ec2:snapshot] DRY RUN: Would snapshot volume ${volumeId}`);
    return "snap-dryrun-0001";
  }

  try {
    const tagSpecs = Object.entries(tags).map(([Key, Value]) => ({
      Key,
      Value,
    }));

    const resp = await ec2!.send(
      new CreateSnapshotCommand({
        VolumeId: volumeId,
        Description: `Hermes agent snapshot — ${tags.agentSessionId ?? "unknown"}`,
        TagSpecifications: [
          {
            ResourceType: "snapshot",
            Tags: tagSpecs,
          },
        ],
      }),
    );

    const snapshotId = resp.SnapshotId;
    console.log(`[ec2:snapshot] Created snapshot ${snapshotId} for volume ${volumeId}`);
    return snapshotId;
  } catch (err) {
    console.warn(
      `[ec2:snapshot] Failed to create snapshot for ${volumeId}:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/**
 * Delete expired snapshots (tagged with Project=hermes and ExpiresAt in the past).
 */
export async function cleanupExpiredSnapshots(): Promise<void> {
  if (config.dryRun) {
    console.log("[ec2:snapshot] DRY RUN: Would cleanup expired snapshots");
    return;
  }

  try {
    const resp = await ec2!.send(
      new DescribeSnapshotsCommand({
        OwnerIds: ["self"],
        Filters: [{ Name: "tag:Project", Values: ["hermes"] }],
      }),
    );

    const now = new Date();
    let deletedCount = 0;

    for (const snapshot of resp.Snapshots ?? []) {
      const expiresAtTag = snapshot.Tags?.find(
        (t) => t.Key === "ExpiresAt",
      )?.Value;
      if (!expiresAtTag) continue;

      const expiresAt = new Date(expiresAtTag);
      if (expiresAt < now) {
        try {
          await ec2!.send(
            new DeleteSnapshotCommand({ SnapshotId: snapshot.SnapshotId! }),
          );
          console.log(`[ec2:snapshot] Deleted expired snapshot ${snapshot.SnapshotId}`);
          deletedCount++;
        } catch (err) {
          console.warn(
            `[ec2:snapshot] Failed to delete snapshot ${snapshot.SnapshotId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    console.log(`[ec2:snapshot] Snapshot cleanup complete: ${deletedCount} deleted`);
  } catch (err) {
    console.warn(
      "[ec2:snapshot] Snapshot cleanup failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
