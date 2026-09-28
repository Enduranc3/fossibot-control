import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** JS side of plugins/fossibot-net (Swift). */
export interface FossibotNetPlugin {
  startServer(opts: { port: number }): Promise<void>;
  stopServer(): Promise<void>;
  send(opts: { hex: string; sessionId?: string }): Promise<void>;
  getNetworkInfo(): Promise<{ interfaces: { name: string; address: string }[] }>;

  wsConnect(opts: { url: string; headers: Record<string, string> }): Promise<void>;
  wsSend(opts: { text: string }): Promise<void>;
  wsClose(): Promise<void>;

  keychainSet(opts: { key: string; value: string }): Promise<void>;
  keychainGet(opts: { key: string }): Promise<{ value?: string | null }>;
  keychainRemove(opts: { key: string }): Promise<void>;

  addListener(event: 'serverState', fn: (e: { state: string; error?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'clientConnected', fn: (e: { sessionId: string; remote: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'clientData', fn: (e: { sessionId: string; hex: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'clientDisconnected', fn: (e: { sessionId: string; error?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'wsOpen', fn: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'wsMessage', fn: (e: { text: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'wsClose', fn: (e: { code: number; reason?: string }) => void): Promise<PluginListenerHandle>;
}

export const FossibotNet = registerPlugin<FossibotNetPlugin>('FossibotNet');

export const isNative = () => Capacitor.isNativePlatform();
