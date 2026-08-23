import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("entrotect", {
  ping: (): string => "pong",
});
