import { useEffect, useState, type FormEvent } from 'react';
import { useText } from '../../../../web/src/ui';
import {
  getPetVoiceSettings, savePetVoiceSettings, voiceError,
  type PetVoiceSettings, type PetVoiceSettingsInput, type VoiceEndpointInput,
} from './voice';
import './voice.css';

type EndpointDraft = VoiceEndpointInput & { hasApiKey: boolean };
type SettingsDraft = Omit<PetVoiceSettingsInput, 'stt' | 'tts'> & {
  stt: EndpointDraft;
  tts: EndpointDraft;
};

const toDraft = (settings: PetVoiceSettings): SettingsDraft => ({
  ...settings,
  stt: { ...settings.stt, apiKey: '', clearApiKey: false },
  tts: { ...settings.tts, apiKey: '', clearApiKey: false },
});

function EndpointFields({ value, onChange }: {
  value: EndpointDraft;
  onChange: (next: EndpointDraft) => void;
}) {
  const t = useText();
  return (
    <div className="pet-voice-fields">
      <label>
        {t('接口地址', 'API base URL')}
        <input type="url" value={value.baseUrl} placeholder="https://…/v1"
          onChange={(event) => onChange({ ...value, baseUrl: event.target.value })} />
      </label>
      <label>
        {t('模型', 'Model')}
        <input value={value.model} onChange={(event) => onChange({ ...value, model: event.target.value })} />
      </label>
      <label>
        {t('API 密钥', 'API key')}
        <input type="password" autoComplete="new-password" spellCheck={false}
          value={value.apiKey ?? ''}
          placeholder={value.hasApiKey ? t('已保存，留空保留', 'Saved; leave blank to keep') : t('本机服务可留空', 'Optional for local services')}
          onChange={(event) => onChange({ ...value, apiKey: event.target.value, clearApiKey: false })} />
      </label>
      {value.hasApiKey && (
        <label className="pet-voice-checkbox">
          <input type="checkbox" checked={Boolean(value.clearApiKey)}
            onChange={(event) => onChange({ ...value, clearApiKey: event.target.checked, apiKey: '' })} />
          {t('清除已保存的密钥', 'Remove saved key')}
        </label>
      )}
    </div>
  );
}

export function VoiceSettings({ onClose, onSaved }: {
  onClose?: () => void;
  onSaved?: (settings: PetVoiceSettings) => void;
}) {
  const t = useText();
  const [form, setForm] = useState<SettingsDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void getPetVoiceSettings().then(
      (settings) => { if (active) setForm(toDraft(settings)); },
      (error) => { if (active) setError(voiceError(error)); },
    );
    return () => { active = false; };
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || busy) return;
    setBusy(true); setError(null); setSaved(false);
    const inputEndpoint = ({ hasApiKey: _, ...endpoint }: EndpointDraft): VoiceEndpointInput => endpoint;
    try {
      const settings = await savePetVoiceSettings({
        ...form, stt: inputEndpoint(form.stt), tts: inputEndpoint(form.tts),
      });
      setForm(toDraft(settings));
      setSaved(true);
      onSaved?.(settings);
    } catch (error) {
      setError(voiceError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="pet-voice-settings" onSubmit={(event) => void save(event)}>
      <header className="pet-voice-heading">
        <strong>{t('语音设置', 'Voice settings')}</strong>
        {onClose && <button type="button" onClick={onClose}>{t('返回', 'Back')}</button>}
      </header>
      {error && <p className="pet-voice-error" role="alert">{error}</p>}
      {!form ? <p>{error ? t('重新打开此面板可重试。', 'Reopen this panel to retry.') : t('正在读取…', 'Loading…')}</p> : (
        <>
          <fieldset disabled={busy}>
            <legend>{t('语音识别', 'Transcription')}</legend>
            <p className="pet-voice-hint">
              {t('按住麦克风说话，松开后转成文字。支持 OpenAI 兼容语音接口和本机服务。', 'Hold the microphone to talk; release to transcribe. Use an OpenAI-compatible speech API or a local service.')}
            </p>
            <EndpointFields value={form.stt} onChange={(stt) => { setForm({ ...form, stt }); setSaved(false); }} />
          </fieldset>
          <fieldset disabled={busy}>
            <legend>{t('回复朗读', 'Read replies aloud')}</legend>
            <label>
              {t('朗读方式', 'Speech engine')}
              <select value={form.ttsEngine} onChange={(event) => {
                setForm({ ...form, ttsEngine: event.target.value as 'system' | 'remote' }); setSaved(false);
              }}>
                <option value="system">{t('系统声音', 'System voices')}</option>
                <option value="remote">{t('远程语音接口', 'Remote speech API')}</option>
              </select>
            </label>
            {form.ttsEngine === 'remote' ? (
              <>
                <EndpointFields value={form.tts} onChange={(tts) => { setForm({ ...form, tts }); setSaved(false); }} />
                <label>
                  {t('声音名称', 'Voice name')}
                  <input value={form.tts.voice} onChange={(event) => {
                    setForm({ ...form, tts: { ...form.tts, voice: event.target.value } }); setSaved(false);
                  }} />
                </label>
              </>
            ) : <p className="pet-voice-hint">{t('使用系统已安装的声音；没有可用声音时可选择远程接口。', 'Uses installed system voices; choose a remote API if none are available.')}</p>}
            <label>
              {t('语速', 'Speech rate')}
              <select value={form.speechRate} onChange={(event) => {
                setForm({ ...form, speechRate: Number(event.target.value) }); setSaved(false);
              }}>
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
              </select>
            </label>
            <label>
              {t('语言', 'Language')}
              <input value={form.language} placeholder={t('zh-CN，留空跟随系统', 'e.g. en-US; blank follows system')}
                onChange={(event) => { setForm({ ...form, language: event.target.value }); setSaved(false); }} />
            </label>
          </fieldset>
          <div className="pet-voice-save">
            <button type="submit" disabled={busy}>{busy ? t('保存中…', 'Saving…') : t('保存', 'Save')}</button>
            {saved && <span role="status">{t('已保存', 'Saved')}</span>}
          </div>
        </>
      )}
    </form>
  );
}
