import {
  CorePluginSignatures,
  MiniflareCore,
  ReloadEvent,
  logResponse,
} from "@miniflare/core";
import type { ScheduledTask } from "node-cron";
import { SchedulerPlugin } from "./plugin";

export * from "./plugin";

export type SchedulerPluginSignatures = CorePluginSignatures & {
  SchedulerPlugin: typeof SchedulerPlugin;
};

const kReload = Symbol("kReload");

export class Scheduler<Plugins extends SchedulerPluginSignatures> {
  // noinspection JSMismatchedCollectionQueryUpdate
  private previousValidatedCrons?: string[];
  private scheduledTasks?: ScheduledTask[];

  constructor(
    private readonly mf: MiniflareCore<Plugins>,
    private readonly cron: Promise<{
      default: typeof import("node-cron");
    }> = import("node-cron")
  ) {
    this[kReload] = this[kReload].bind(this);
    mf.addEventListener("reload", this[kReload]);
  }

  async [kReload](event: ReloadEvent<Plugins>): Promise<void> {
    const validatedCrons = event.plugins.SchedulerPlugin.validatedCrons;
    // Checking references here, if different, SchedulerPlugin setup must've
    // been called meaning crons changed so reload scheduled tasks
    if (this.previousValidatedCrons === validatedCrons) return;
    this.previousValidatedCrons = validatedCrons;

    // Schedule tasks, stopping all current ones first
    this.scheduledTasks?.forEach((task) => task.destroy());
    if (!validatedCrons.length) return;
    const cron = await this.cron;
    this.scheduledTasks = validatedCrons?.map((expression) =>
      cron.default.schedule(expression, async () => {
        const start = process.hrtime();
        // scheduledTime will default to Date.now()
        const waitUntil = this.mf.dispatchScheduled(undefined, expression);
        await logResponse(this.mf.log, {
          start,
          method: "SCHD",
          url: expression,
          waitUntil,
        });
      })
    );
  }

  dispose(): void {
    this.mf.removeEventListener("reload", this[kReload]);
    this.scheduledTasks?.forEach((task) => task.destroy());
  }
}

export async function startScheduler<Plugins extends SchedulerPluginSignatures>(
  mf: MiniflareCore<Plugins>,
  cron?: Promise<{ default: typeof import("node-cron") }>
): Promise<Scheduler<Plugins>> {
  const scheduler = new Scheduler(mf, cron);
  await scheduler[kReload](new ReloadEvent(await mf.getPlugins()));
  return scheduler;
}
