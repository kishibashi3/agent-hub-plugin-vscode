// agent-hub-bridge-vscode — entry point.
//
// Step 2 wires the SSE inbox watch (see `./agentHub.ts`). LM bridging,
// IDE context auto-attach, and reply relay still arrive in later PRs.

import * as vscode from 'vscode';

import {
  BridgeConfig,
  InboxMessageNotification,
  InboxWatcher,
  LOCALHOST_DEFAULT_URL,
} from './agentHub';

const CHANNEL_NAME = 'agent-hub bridge';

let outputChannel: vscode.OutputChannel | undefined;
let watcher: InboxWatcher | undefined;
let watcherDisposable: vscode.Disposable | undefined;

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel?.appendLine(`[${ts}] ${msg}`);
}

function readConfig(): BridgeConfig {
  const cfg = vscode.workspace.getConfiguration('agentHubBridge');
  // Note: VS Code config returns "" for unset string keys (default declared
  // in package.json), never undefined. Use `||` everywhere so empty-string
  // falls through to the placeholder — `??` would only catch undefined and
  // leave the empty string in place (cosmetic bug, but easy to get wrong).
  return {
    url: cfg.get<string>('url') || LOCALHOST_DEFAULT_URL,
    user: cfg.get<string>('user') || '',
    tenant: cfg.get<string>('tenant') || '',
    githubPat: cfg.get<string>('githubPat') || '',
  };
}

function handleInboxNotification(notification: InboxMessageNotification): void {
  // Step 2 stops here: we *know* something landed in the inbox. Reading the
  // message body via `get_messages`, dispatching it to `vscode.lm.sendRequest`,
  // attaching IDE context, and replying via `send_message` are wired up in
  // subsequent PRs (Steps 3-5 of issue #1).
  log(
    `[event] inbox notification ${notification.uri} at ${notification.receivedAt.toISOString()} ` +
      '(LM bridging arrives in a follow-up PR)'
  );
}

async function startWatcher(): Promise<void> {
  if (watcher) {
    void vscode.window.showInformationMessage('agent-hub bridge: already running.');
    return;
  }
  const config = readConfig();
  const w = new InboxWatcher(config, log);
  // Subscribe before start() so we never miss the first event the watcher
  // emits after subscribe returns.
  const disposable = w.onMessage(handleInboxNotification);
  watcherDisposable = disposable;

  try {
    await w.start();
  } catch (err) {
    disposable.dispose();
    watcherDisposable = undefined;
    w.dispose();
    const msg = err instanceof Error ? err.message : String(err);
    log(`[ERR] start: ${msg}`);
    void vscode.window.showErrorMessage(`agent-hub bridge: start failed — ${msg}`);
    return;
  }

  watcher = w;
  outputChannel?.show(true);
  void vscode.window.showInformationMessage('agent-hub bridge: inbox watch started.');
}

async function stopWatcher(): Promise<void> {
  if (!watcher) {
    void vscode.window.showInformationMessage('agent-hub bridge: not running.');
    return;
  }
  const w = watcher;
  watcher = undefined;
  watcherDisposable?.dispose();
  watcherDisposable = undefined;
  await w.stop();
  w.dispose();
  void vscode.window.showInformationMessage('agent-hub bridge: inbox watch stopped.');
}

function showStatus(): void {
  const cfg = readConfig();
  const state = watcher?.state ?? {
    running: false,
    mode: 'idle' as const,
    sessionId: null,
    authMode: null,
    userId: null,
  };
  const url = cfg.url || '';
  const user = state.userId ?? cfg.user ?? '';
  const tenant = cfg.tenant || '(default)';
  const sid = state.sessionId ? `${state.sessionId.slice(0, 8)}...` : 'none';
  const auth = state.authMode ?? '(not started)';
  const summary =
    `agent-hub bridge — url=${url} user=${user || '(unset)'} tenant=${tenant} ` +
    `auth=${auth} watcher=${state.mode} sessionId=${sid}`;
  log(summary);
  void vscode.window.showInformationMessage(summary);
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  log('agent-hub bridge activated');

  context.subscriptions.push(
    vscode.commands.registerCommand('agentHubBridge.start', () => startWatcher()),
    vscode.commands.registerCommand('agentHubBridge.stop', () => stopWatcher()),
    vscode.commands.registerCommand('agentHubBridge.status', () => showStatus()),
    {
      dispose: () => {
        watcherDisposable?.dispose();
        watcherDisposable = undefined;
        watcher?.dispose();
        watcher = undefined;
      },
    }
  );
}

export function deactivate(): void {
  log('agent-hub bridge deactivated');
  watcherDisposable?.dispose();
  watcherDisposable = undefined;
  watcher?.dispose();
  watcher = undefined;
  outputChannel?.dispose();
  outputChannel = undefined;
}
