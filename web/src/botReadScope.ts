/** A deletion invalidates reads synchronously, before React unmounts the chat. */
export class BotReadScope {
  private revision = 0;
  private paused = false;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.revision;
  isCurrent(revision: number) { return !this.paused && revision === this.revision; }
  suspend() { this.paused = true; this.changed(); }
  resume() { this.paused = false; this.changed(); }
  private changed() {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}
