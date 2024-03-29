'use strict';

/**
 * A single TimeTrace encapsulates the runtime of a selected code frame.
 *
 * @class TimeTrace
 */
class TimeTrace {
  /**
   * Creates an instance of TimeTrace.
   * @param {string} id
   *
   * @memberOf TimeTrace
   */
  constructor(id) {
    let startTime;
    /**
     * Start measuring.
     *
     * @param {number} indent
     */
    this.start = function start(indent) {
      // eslint-disable-next-line no-console
      console.error(`${ ' '.repeat((indent) * 2) }${ id } started`);
      startTime = process.hrtime();
    };

    /**
     * Stop measuring and log the result
     *
     * @param {number} indent
     */
    this.stop = function stop(indent) {
      const endTime = process.hrtime(startTime);
      const base = `${ ' '.repeat(indent * 2) }${ id } took:`;
      // eslint-disable-next-line no-console
      console.error( `${ base }${ ' '.repeat(60 - base.length) } %ds %dms`, endTime[0], endTime[1] / 1000000);
    };
  }
}

/**
 * The main class to handle measuring the runtime of code blocks
 *
 * Results are logged to stderr
 *
 * To enable time tracing, set CDSC_TIMETRACE to true in the environment
 *
 * @class TimeTracer
 */
class TimeTracer {
  /**
   * Creates an instance of TimeTracer.
   *
   * @memberOf TimeTracer
   */
  constructor() {
    this.traceStack = [];
  }

  /**
   * Start a new TimeTrace, using the given id for logging etc.
   *
   * @param {string} id A short description of whats going on
   *
   * @memberOf TimeTracer
   */
  start(id) {
    try {
      const b = new TimeTrace(id);
      this.traceStack.push(b);
      b.start(this.traceStack.length - 1);
    }
    catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Starting time trace with id ${ id } failed: ${ e }`);
    }
  }

  /**
   * Stop the current TimeTrace and log the execution time.
   *
   *
   * @memberOf TimeTracer
   */
  stop() {
    try {
      const current = this.traceStack.pop();
      current.stop(this.traceStack.length);
    }
    catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Stopping time trace failed: ${ e }`);
    }
  }
}

const ignoreTimeTrace = {
  start: () => { /* ignore */ },
  stop: () => { /* ignore */ },
};

const doTimeTrace = process && process.env && process.env.CDSC_TIMETRACING !== undefined;
module.exports = doTimeTrace ? new TimeTracer() : ignoreTimeTrace;
