// agent-hub-bridge-vscode — entry point.
//
// Wires the SSE inbox watch (`./agentHub.ts`) and the @agent-hub Chat
// participant (`./chatParticipant.ts`).
//
// Inbound DMs are surfaced as VS Code notifications (no LM invocation).
// LM auto-dispatch was removed in v0.8.0 (issue #35).

import * as vscode from 'vscode';

import {
  BridgeConfig,
  InboxWatcher,
  LOCALHOST_DEFAULT_URL,
  isDefaultLocalhostUrl,
} from './agentHub';
import { registerChatParticipant } from './chatParticipant';
import { LmDispatcher } from './lmDispatcher';
import { fetchGitHubLogin } from './protocol';

const SECRET_KEY_GITHUB_PAT = 'agentHubBridge.githubPat';

const CHANNEL_NAME = 'agent-hub bridge';

let outputChannel: vscode.OutputChannel | undefined;
let watcher: InboxWatcher | undefined;
let watcherDisposable: vscode.Disposable | undefined;
let dispatcher: LmDispatcher | undefined;

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel?.appendLine(`[${ts}] ${msg}`);
}

async function readConfig(context: vscode.ExtensionContext): Promise<BridgeConfig> {
  const cfg = vscode.workspace.getConfiguration('agentHubBridge');
  // Note: VS Code config returns "" for unset string keys (default declared
  // in package.json), never undefined. Use `||` everywhere so empty-string
  // falls through to the placeholder — `??` would only catch undefined and
  // leave the empty string in place (cosmetic bug, but easy to get wrong).
  //
  // The GitHub PAT lives in `SecretStorage` only — the legacy
  // `agentHubBridge.githubPat` setting was removed in 0.4.0 (issue #15).
  const secretPat = ((await context.secrets.get(SECRET_KEY_GITHUB_PAT)) ?? '').trim();

  return {
    url: cfg.get<string>('url') || LOCALHOST_DEFAULT_URL,
    user: cfg.get<string>('user') || '',
    tenant: cfg.get<string>('tenant') || '',
    githubPat: secretPat,
  };
}

async function startWatcher(context: vscode.ExtensionContext): Promise<void> {
  if (watcher) {
    void vscode.window.showInformationMessage('agent-hub bridge: already running.');
    return;
  }

  const config = await readConfig(context);

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
  const d = new LmDispatcher({ watcher: w, log });
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

async function showStatus(context: vscode.ExtensionContext): Promise<void> {
  const cfg = await readConfig(context);
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
  // Surface whether the secret store is populated. Post-0.4.0 the only
  // place a PAT can live is `SecretStorage` — the legacy plaintext
  // setting was removed.
  const secretPat = (await context.secrets.get(SECRET_KEY_GITHUB_PAT)) ?? '';
  const patSource = secretPat.trim().length > 0 ? 'secret' : 'none';
  const summary =
    `agent-hub bridge — url=${url} user=${user || '(unset)'} tenant=${tenant} ` +
    `auth=${auth} watcher=${state.mode} sessionId=${sid} pat=${patSource}`;
  log(summary);
  void vscode.window.showInformationMessage(summary);
}

async function setGithubPatCommand(context: vscode.ExtensionContext): Promise<void> {
  const pat = await vscode.window.showInputBox({
    prompt:
      'Paste a GitHub PAT with the read:user scope. The value is stored via VS Code ' +
      'SecretStorage (OS keychain on macOS/Windows, libsecret on Linux) and never ' +
      'written to settings.json.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'ghp_…',
  });
  if (pat === undefined) {
    // User dismissed the input box — no-op, no popup.
    return;
  }
  const trimmed = pat.trim();
  if (!trimmed) {
    void vscode.window.showErrorMessage(
      'agent-hub bridge: empty PAT — nothing was stored.'
    );
    return;
  }

  log('[secret] validating new PAT against api.github.com/user…');
  const login = await fetchGitHubLogin(trimmed);
  if (!login) {
    void vscode.window.showErrorMessage(
      'agent-hub bridge: GitHub rejected that PAT (revoked, expired, or missing the ' +
        'read:user scope). Nothing was stored.'
    );
    return;
  }

  // PR #10 Suggestion 1 fold-in: `secrets.store` can fail (locked keychain
  // etc.) — surface the underlying error so the user knows their PAT
  // wasn't actually persisted.
  try {
    await context.secrets.store(SECRET_KEY_GITHUB_PAT, trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[ERR] setGithubPat: secrets.store failed — ${msg}`);
    void vscode.window.showErrorMessage(
      `agent-hub bridge: could not store PAT in secret storage (${msg}). ` +
        'No value was persisted.'
    );
    return;
  }
  log(`[secret] stored agentHubBridge.githubPat (validated for GitHub user @${login})`);
  void vscode.window.showInformationMessage(
    `agent-hub bridge: PAT stored for GitHub user @${login}.`
  );
}

async function clearGithubPatCommand(context: vscode.ExtensionContext): Promise<void> {
  const existing = await context.secrets.get(SECRET_KEY_GITHUB_PAT);
  if (!existing) {
    void vscode.window.showInformationMessage(
      'agent-hub bridge: no GitHub PAT is stored in secret storage.'
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    'agent-hub bridge: clear the stored GitHub PAT? You will fall back to the ' +
      '`agentHubBridge.githubPat` setting (if any) or trust mode (if user is set).',
    { modal: true },
    'Clear'
  );
  if (choice !== 'Clear') return;
  // PR #10 Suggestion 1 fold-in: `secrets.delete` can fail the same way
  // `secrets.store` can. Surface the error rather than silently leaving
  // the stale value in place.
  try {
    await context.secrets.delete(SECRET_KEY_GITHUB_PAT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[ERR] clearGithubPat: secrets.delete failed — ${msg}`);
    void vscode.window.showErrorMessage(
      `agent-hub bridge: could not clear PAT from secret storage (${msg}). ` +
        'The stored value still exists; retry, or check OS keychain access.'
    );
    return;
  }
  log('[secret] cleared agentHubBridge.githubPat from secret storage');
  void vscode.window.showInformationMessage('agent-hub bridge: GitHub PAT cleared.');
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  log('agent-hub bridge activated');

  context.subscriptions.push(
    vscode.commands.registerCommand('agentHubBridge.start', () => startWatcher(context)),
    vscode.commands.registerCommand('agentHubBridge.stop', () => stopWatcher()),
    vscode.commands.registerCommand('agentHubBridge.status', () => showStatus(context)),
    vscode.commands.registerCommand('agentHubBridge.setGithubPat', () =>
      setGithubPatCommand(context)
    ),
    vscode.commands.registerCommand('agentHubBridge.clearGithubPat', () =>
      clearGithubPatCommand(context)
    ),
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

  // Register the @agent-hub Copilot Chat participant (issue #28).
  registerChatParticipant(
    context,
    () => watcher,
    () => startWatcher(context),
    log
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
