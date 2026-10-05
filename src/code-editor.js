import { EditorView, basicSetup } from 'codemirror';
import { javascript, javascriptLanguage, scopeCompletionSource } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { DEFAULT_CODE, createSimulationRunner } from './simulation.js';
import { createEditorPanel } from './editor-panel.js';

export function createCodeEditor({ api, onStop }) {
  const panel = document.getElementById('script-panel');
  const toggleButton = document.getElementById('toggle-script');
  const status = document.getElementById('script-status');
  let panelControls;

  function showStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('script-error', error);
  }

  const runner = createSimulationRunner(api, {
    onStop,
    onStateChange(running, phase) {
      toggleButton.textContent = running ? 'Stop' : 'Run';
      toggleButton.title = running ? 'Stop simulation (Ctrl / Cmd + Enter or Escape in editor)' : 'Run code (Ctrl / Cmd + Enter)';
      toggleButton.disabled = false;
      panel.dataset.running = String(running);
      showStatus(phase === 'starting' ? 'Starting sandbox…' : running ? 'Running' : 'Stopped');
    },
    onError(error) {
      panelControls?.setCollapsed(false);
      const location = error?.line ? ' (line ' + error.line + (error.column ? ', column ' + error.column : '') + ')' : '';
      showStatus(`${error?.name || 'Error'}${location}: ${error?.message || String(error)}`, true);
      console.error('updateGun:', error);
    },
  });

  const editor = new EditorView({
    parent: document.getElementById('code-editor'),
    doc: DEFAULT_CODE,
    extensions: [
      basicSetup,
      javascript(),
      oneDark,
      javascriptLanguage.data.of({ autocomplete: scopeCompletionSource(api) }),
      EditorView.contentAttributes.of({ 'aria-label': 'JavaScript gun control code', spellcheck: 'false' }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px', backgroundColor: '#0d1720' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Liberation Mono", monospace' },
        '.cm-content': { padding: '12px 0' },
        '.cm-gutters': { backgroundColor: '#101d27', color: '#617b89', border: 'none' },
      }, { dark: true }),
      EditorView.domEventHandlers({
        keydown(event) {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            toggleSimulation();
            return true;
          }
          if (event.key === 'Escape' && runner.isRunning()) {
            event.preventDefault();
            runner.stop();
            return true;
          }
          return false;
        },
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          showStatus(runner.isRunning() ? 'Running — edits apply on the next run' : 'Ready');
        }
      }),
    ],
  });

  panelControls = createEditorPanel(panel, () => editor.requestMeasure());

  function toggleSimulation() {
    if (runner.isRunning()) runner.stop();
    else runner.run(editor.state.doc.toString());
  }
  toggleButton.addEventListener('click', toggleSimulation);
  toggleButton.disabled = false;
  showStatus('Ready');

  return {
    tick: (deltaTime, radarData) => runner.tick(deltaTime, radarData),
    destroy() {
      runner.stop();
      toggleButton.removeEventListener('click', toggleSimulation);
      panelControls.destroy();
      editor.destroy();
      toggleButton.disabled = true;
    },
  };
}
