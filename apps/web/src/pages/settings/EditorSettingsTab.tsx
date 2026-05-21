import { Button, Input, Label } from '@scribe/ui';
import { useTranslation } from 'react-i18next';

import { type EditorPreferences, useSettings } from '../../stores/settings';

interface ToggleProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly description?: string;
}

function Toggle({ checked, onChange, label, description }: ToggleProps) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => { onChange(e.target.checked); }}
        className="mt-0.5"
      />
      <span className="flex-1">
        <span className="block text-sm font-medium">{label}</span>
        {description !== undefined ? (
          <span className="block text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
    </label>
  );
}

export function EditorSettingsTab() {
  const { t } = useTranslation();
  const editor = useSettings((s) => s.editor);
  const setEditorPref = useSettings((s) => s.setEditorPref);
  const resetEditor = useSettings((s) => s.resetEditor);

  function bound<K extends keyof EditorPreferences>(key: K) {
    return (value: EditorPreferences[K]) => { setEditorPref(key, value); };
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="editor-font">{t('settings.editor.fontSize')}</Label>
          <Input
            id="editor-font"
            type="number"
            min={10}
            max={24}
            value={editor.fontSize}
            onChange={(e) => { bound('fontSize')(Number(e.target.value)); }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="editor-ruler">{t('settings.editor.rulerColumn')}</Label>
          <Input
            id="editor-ruler"
            type="number"
            min={0}
            max={200}
            value={editor.rulerColumn}
            onChange={(e) => { bound('rulerColumn')(Number(e.target.value)); }}
          />
          <p className="text-xs text-muted-foreground">{t('settings.editor.rulerColumnHint')}</p>
        </div>
      </div>

      <div className="space-y-3">
        <Toggle
          checked={editor.autocomplete}
          onChange={bound('autocomplete')}
          label={t('settings.editor.autocomplete')}
          description={t('settings.editor.autocompleteDesc')}
        />
        <Toggle
          checked={editor.ghostText}
          onChange={bound('ghostText')}
          label={t('settings.editor.ghostText')}
          description={t('settings.editor.ghostTextDesc')}
        />
        <Toggle
          checked={editor.vimMode}
          onChange={bound('vimMode')}
          label={t('settings.editor.vimMode')}
          description={t('settings.editor.vimModeDesc')}
        />
      </div>

      <div className="border-t pt-3">
        <Button type="button" variant="ghost" size="sm" onClick={resetEditor}>
          {t('settings.editor.resetDefaults')}
        </Button>
      </div>
    </div>
  );
}
