import { ILanguageServerPlugin } from '@sqltools/types';
import Heimdall from './driver';
import { DRIVER_ALIASES } from './../constants';
import { REFRESH_METADATA, CLEAR_METADATA, MetadataRequestParams, MetadataRequestResult } from '../ipc';

const HeimdallDriverPlugin: ILanguageServerPlugin = {
  register(server) {
    DRIVER_ALIASES.forEach(({ value }) => {
      server.getContext().drivers.set(value, Heimdall as any);
    });

    // UoW-05: hand the server reference to the driver class so `query()` can
    // push `TARGET_MISMATCH` (see `../ipc.ts`) LS->ext on a real mismatch —
    // the only way a driver instance (no `vscode`, runs in the LS process)
    // can raise anything the extension host acts on.
    Heimdall.setServer(server);

    // UoW-02: metadata cache commands (see `../ipc.ts`). Looked up by connId
    // through `Heimdall.getInstance` (`./driver.ts`) since `LSContextMap.drivers`
    // only maps driver type -> class, not the live per-connection instance.
    server.onRequest(REFRESH_METADATA, async ({ connId }: MetadataRequestParams): Promise<MetadataRequestResult> => {
      const driver = Heimdall.getInstance(connId);
      if (!driver) {
        return { message: 'No active Heimdall connection to refresh — connect first.' };
      }
      return driver.refreshMetadata();
    });

    server.onRequest(CLEAR_METADATA, async ({ connId }: MetadataRequestParams): Promise<MetadataRequestResult> => {
      const driver = Heimdall.getInstance(connId);
      if (!driver) {
        return { message: 'No active Heimdall connection to clear — connect first.' };
      }
      return driver.clearMetadata();
    });
  }
}

export default HeimdallDriverPlugin;
