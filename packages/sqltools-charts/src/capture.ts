import { NSDatabase, IExtension, ICommandEvent, ICommandSuccessEvent } from '@sqltools/types';
import { getNameFromId } from '@sqltools/util/connection';

// ponytail: no vscode import here (deliberately) — this file has no vscode
// APIs otherwise, and keeping it vscode-free lets capture.test.ts run under
// plain `node --test` without a vscode shim. A minimal pub-sub stands in for
// vscode.EventEmitter.
class Emitter<T> {
  private listeners: ((e: T) => void)[] = [];
  public event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  public fire(e: T) {
    this.listeners.forEach(l => l(e));
  }
}

export const HOOKED_COMMANDS = ['executeQuery', 'executeCurrentQuery', 'executeQueryFromFile'];

// default ring buffer size, mirrors history-manager's `historySize` default (100)
const MAX_ENTRIES = 100;

export interface CaptureEntry {
  connId: string;
  connectionName: string;
  query: string;
  durationMs: number;
  status: 'success' | 'error';
  rowCount: number;
  result: NSDatabase.IResult;
  timestamp: number;
}

export class ResultCapture {
  private entries: CaptureEntry[] = [];
  // ponytail: no per-invocation correlation id exists on ICommandEvent, only
  // {command, args}. We key start-times by command name, on the assumption
  // that SQLTools only ever runs one query at a time per connection, so these
  // hooked commands run to completion before the same command name fires
  // again. Ceiling: two overlapping invocations of the *same* command (e.g.
  // two connections executing concurrently) would misattribute duration to
  // each other. Upgrade path: thread a correlation id through if SQLTools
  // ever adds one to ICommandEvent.
  private startTimes: { [command: string]: number } = {};

  private _onDidChange = new Emitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  public register(extension: IExtension) {
    HOOKED_COMMANDS.forEach(cmd => {
      extension.addBeforeCommandHook(cmd, this.onBefore);
      extension.addAfterCommandSuccessHook(cmd, this.onAfter);
    });
  }

  private onBefore = (evt: ICommandEvent) => {
    this.startTimes[evt.command] = Date.now();
  };

  private onAfter = (evt: ICommandSuccessEvent<NSDatabase.IResult[]>) => {
    const start = this.startTimes[evt.command] ?? Date.now();
    const durationMs = Date.now() - start;
    (evt.result || []).forEach(result => {
      this.entries.unshift({
        connId: result.connId,
        connectionName: getNameFromId(result.connId),
        query: result.query,
        durationMs,
        status: result.error ? 'error' : 'success',
        rowCount: result.results?.length ?? 0,
        result,
        timestamp: Date.now(),
      });
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
    this._onDidChange.fire();
  };

  public getEntries(): CaptureEntry[] {
    return this.entries;
  }

  public getLatest(): CaptureEntry | undefined {
    return this.entries[0];
  }

  public clear() {
    this.entries = [];
    this._onDidChange.fire();
  }
}

export default ResultCapture;
