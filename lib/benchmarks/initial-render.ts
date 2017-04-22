import * as fs from "fs";
import {
  Benchmark,
  IBenchmarkMeta,
  IBenchmarkParams,
} from "../benchmark";
import { Network } from "../debugging-protocol-domains";
import { ITab } from "../tab";
import InitialRenderMetric, {
  IInitialRenderSamples,
  IMarker,
} from "./initial-render-metric";

export interface IInitialRenderBenchmarkParams extends IBenchmarkParams {
  /**
   * URL to measure initial render of.
   */
  url: string;

  /**
   * Performance marks to divide up phases.
   *
   * The last mark until paint will define the duration sample.
   */
  markers: IMarker[];

  /**
   * Collect GC stats (experimental). Does not seem to get consistently output
   * in each trace.
   */
  gcStats?: boolean;

  /**
   * Collect runtime call stats.
   *
   * This is a disabled-by-default tracing category so may add some overhead
   * to result.
   */
  runtimeStats?: boolean;

  /**
   * Trace while throttling CPU.
   */
  cpuThrottleRate?: number;

  /**
   * Trace while emulating network conditions.
   */
  networkConditions?: Network.emulateNetworkConditions_Parameters;

  /**
   * Save trace for first iteration.
   *
   * Useful for double checking you are measuring what you think you are
   * measuring.
   */
  saveFirstTrace?: string;

  /**
   * Save trace for each iteration, useful for debugging outliers in data.
   */
  saveTraces?: (iteration: number) => string;
}

/**
 * Benchmark by tracing nativation to url and measuring marks of phases until
 * Paint.
 */
export class InitialRenderBenchmark extends Benchmark<IInitialRenderSamples> {
  protected params: IInitialRenderBenchmarkParams;

  constructor(params: IInitialRenderBenchmarkParams) {
    validateParams(params);
    super(params);
    this.params = params;
  }

  protected createResults(meta: IBenchmarkMeta): IInitialRenderSamples {
    return {
      meta,
      samples: [],
      set: this.name,
    };
  }

  protected async performIteration(t: ITab, results: IInitialRenderSamples, i: number): Promise<void> {
    const url = this.params.url;
    const markers = this.params.markers;

    let categories = "blink.user_timing,benchmark,toplevel,devtools.timeline,v8,v8.execute";

    if (this.params.gcStats) {
      categories += ",disabled-by-default-v8.gc_stats";
    }

    if (this.params.runtimeStats) {
      categories += ",disabled-by-default-v8.runtime_stats";
    }

    if (this.params.cpuThrottleRate !== undefined) {
      await t.setCPUThrottlingRate(this.params.cpuThrottleRate);
    }

    if (this.params.networkConditions !== undefined) {
      await t.emulateNetworkConditions(this.params.networkConditions);
    }

    await t.startTracing(categories);
    // TODO this assumes that complete won't happen before we call
    // endTracing, this is normally true but need to revisit.
    await Promise.all([
      new Promise((resolve) => {
        t.onNavigate = () => {
          if (t.frame.url === "about:blank") {
            t.onNavigate = null;
            resolve();
          }
        };
      }),
      await t.navigate(url),
    ]);

    const trace = await t.endTracing();

    if (!trace.mainProcess || !trace.mainProcess.mainThread) {
      console.warn("unable to find main process");
      return;
    }

    if (this.params.cpuThrottleRate !== undefined) {
      await t.setCPUThrottlingRate(1);
    }

    if (this.params.networkConditions !== undefined) {
      await t.disableNetworkEmulation();
    }

    if (i === 0 && this.params.saveFirstTrace) {
      fs.writeFileSync(this.params.saveFirstTrace, JSON.stringify(trace.events, null, 2));
    }

    if (this.params.saveTraces) {
      fs.writeFileSync(this.params.saveTraces(i), JSON.stringify(trace.events, null, 2));
    }

    const metric = new InitialRenderMetric(markers, this.params.gcStats);
    const sample = metric.measure(trace);

    // log progress to stderr
    // TODO make some events or logger
    console.error(`${this.name} ${sample.duration} µs`);

    results.samples.push(sample);
  }
}

function validateParams(params: IInitialRenderBenchmarkParams) {
  if (!params.markers || params.markers.length === 0) {
    params.markers = [{
      label: "render",
      start: "fetchStart",
    }];
  }
  if (!params.url) {
    throw new Error("url is required");
  }
}
