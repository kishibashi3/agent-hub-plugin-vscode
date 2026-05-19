// agent-hub-bridge-vscode — entry point.
//
// Step 2 wires the SSE inbox watch (see `./agentHub.ts`). LM bridging,
// IDE context auto-attach, and reply relay still arrive in later PRs.

import * as vscode from 'vscode';

import {
  BridgeConfig,
  InboxWatcher,
  LOCALHOST_DEFAULT_URL,
  isDefaultLocalhostUrl,
} from './agentHub';
import { DEFAULT_IDE_CONTEXT_OPTIONS, type IdeContextOptions } from './ideContext';
import { LmDispatcher, LmDispatcherConfig } from './lmDispatcher';

const CHANNEL_NAME = 'agent-hub bridge';

const DEFAULT_SYSTEM_PROMPT =
  'You are an AI agent participating in agent-hub, a multi-agent ' +
  'collaboration platform. The user has sent you a direct message. ' +
  'Respond helpfully and concisely. Keep the reply focused on the ' +
  'message — no excessive greetings, no echoing the prompt back.';

const DEFAULT_JUSTIFICATION =
  'agent-hub bridge is responding to a DM relayed from another participant.';

let outputChannel: vscode.OutputChannel | undefined;
let watcher: InboxWatcher | undefined;
let watcherDisposable: vscode.Disposable | undefined;
let dispatcher: LmDispatcher | undefined;

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

function readDispatcherConfig(): LmDispatcherConfig {
  const cfg = vscode.workspace.getConfiguration('agentHubBridge');
  const systemPrompt = cfg.get<string>('systemPrompt');
  const vendor = cfg.get<string>('languageModel.vendor') || 'copilot';
  const family = cfg.get<string>('languageModel.family') || '';
  // Drop empty-string fields from the selector so VS Code's matcher
  // doesn't try to look for a model literally named "".
  const selector: vscode.LanguageModelChatSelector = { vendor };
  if (family.length > 0) {
    selector.family = family;
  }
  return {
    systemPrompt:
      typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
        ? systemPrompt
        : DEFAULT_SYSTEM_PROMPT,
    modelSelector: selector,
    justification: DEFAULT_JUSTIFICATION,
    ideContext: readIdeContextOptions(cfg),
  };
}

function readIdeContextOptions(
  cfg: vscode.WorkspaceConfiguration
): IdeContextOptions {
  // Honour user overrides but always fall back to the documented defaults
  // for unset / malformed values so a corrupt settings.json never silently
  // disables context attach. Numeric keys are floored to non-negative.
  const enabled = cfg.get<boolean>('ideContext.enabled');
  const maxSelChars = cfg.get<number>('ideContext.maxSelectionChars');
  const maxDiag = cfg.get<number>('ideContext.maxDiagnostics');
  const windowLines = cfg.get<number>('ideContext.windowLinesAroundCursor');
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_IDE_CONTEXT_OPTIONS.enabled,
    maxSelectionChars: nonNegativeInt(
      maxSelChars,
      DEFAULT_IDE_CONTEXT_OPTIONS.maxSelectionChars
    ),
    maxDiagnostics: nonNegativeInt(maxDiag, DEFAULT_IDE_CONTEXT_OPTIONS.maxDiagnostics),
    windowLinesAroundCursor: nonNegativeInt(
      windowLines,
      DEFAULT_IDE_CONTEXT_OPTIONS.windowLinesAroundCursor
    ),
  };
}

function nonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

async function startWatcher(): Promise<void> {
  if (watcher) {
    void vscode.window.showInformationMessage('agent-hub bridge: already running.');
    return;
  }
  const config = readConfig();

  // Redline #1 visibility (per PR #3 reviewer Minor 1): the watcher already
  // logs a `[WARN]` to the output channel, but a passive log line is easy to
  // miss when the channel isn't focused. Surface a popup with a one-click
  // path into Settings so the user can't unknowingly connect a non-local
  // workspace to localhost. We only fire once per start, dismissible.
  if (isDefaultLocalhostUrl(config.url)) {
    void vscode.window
      .showWarningMessage(
        'agent-hub bridge: connecting to the dev-localhost default URL ' +
          `(${LOCALHOST_DEFAULT_URL}). If you intended a non-local deployment, ` +
          'override agentHubBridge.url first (redline #1: no silent production fallback).',
        'Open Settings',
        'Continue'
      )
      .then((choice) => {
        if (choice === 'Open Settings') {
          void vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'agentHubBridge.url'
          );
        }
      });
  }

  const w = new InboxWatcher(config, log);
  const d = new LmDispatcher({ watcher: w, cfg: readDispatcherConfig(), log });
  // Subscribe before start() so we never miss the first event the watcher
  // emits after subscribe returns. The dispatcher's onInboxNotification
  // requestDrain()s, which then fetches *all* unread messages — so even if
  // the very first notification fires before this listener attaches, the
  // post-start drain below picks it up.
  const disposable = w.onMessage(d.onInboxNotification);
  watcherDisposable = disposable;

  try {
    await w.start();
  } catch (err) {
    disposable.dispose();
    watcherDisposable = undefined;
    d.dispose();
    w.dispose();
    const msg = err instanceof Error ? err.message : String(err);
    log(`[ERR] start: ${msg}`);
    void vscode.window.showErrorMessage(`agent-hub bridge: start failed — ${msg}`);
    return;
  }

  watcher = w;
  dispatcher = d;
  outputChannel?.show(true);
  void vscode.window.showInformationMessage('agent-hub bridge: inbox watch started.');

  // Drain anything that arrived while the bridge was offline. SSE only
  // notifies *new* arrivals, so without this kick existing unread messages
  // would sit in the inbox until the next DM nudges the pipeline awake.
  d.requestDrain();
}

async function stopWatcher(): Promise<void> {
  if (!watcher) {
    void vscode.window.showInformationMessage('agent-hub bridge: not running.');
    return;
  }
  const w = watcher;
  const d = dispatcher;
  watcher = undefined;
  dispatcher = undefined;
  watcherDisposable?.dispose();
  watcherDisposable = undefined;
  d?.dispose();
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
        dispatcher?.dispose();
        dispatcher = undefined;
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
  dispatcher?.dispose();
  dispatcher = undefined;
  watcher?.dispose();
  watcher = undefined;
  outputChannel?.dispose();
  outputChannel = undefined;
}
