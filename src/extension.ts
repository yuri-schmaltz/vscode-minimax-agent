/**
 * Mavis extension entry point — Fase 0 placeholder.
 *
 * Wires up nothing but the hello command. Subsequent commits add the
 * MavisClient, OAuth, status bar, and chat webview.
 */
import { commands, ExtensionContext, window } from 'vscode';

export function activate(_context: ExtensionContext): void {
  window.showInformationMessage('MiniMax Agent (Mavis) ready. Cmd/Ctrl+Shift+M to open chat.');
  _context.subscriptions.push(
    commands.registerCommand('mavis.hello', () => {
      window.showInformationMessage('Hello from Mavis');
    }),
    commands.registerCommand('mavis.toggleChat', () => {
      commands.executeCommand('workbench.view.mavis-chat');
    }),
    commands.registerCommand('mavis.openSettings', () => {
      commands.executeCommand('workbench.action.openSettings', 'mavis');
    }),
  );
}

export function deactivate(): void {
  // no-op
}
