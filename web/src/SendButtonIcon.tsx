import { ArrowUp, LoaderCircle } from 'lucide-react';
import './send-feedback.css';

export function SendButtonIcon({ busy, size = 18 }: { busy: boolean; size?: number }) {
  return busy
    ? <LoaderCircle className="send-button-spinner" size={size} aria-hidden="true" />
    : <ArrowUp size={size} aria-hidden="true" />;
}
