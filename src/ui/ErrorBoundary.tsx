import { Component, type ReactNode } from "react";

// A bug in one panel shouldn't blank the whole office. This catches it, shows what broke, and
// lets the boss close the panel; `resetKey` tries again when the panel's content changes.

interface Props {
  name: string;
  onClose: () => void;
  resetKey?: unknown;
  action?: string; // the button's label, "Close" by default
  center?: boolean; // for a full-size area like the 3D office, rather than a side panel
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.name}]`, error);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={`panel-error${this.props.center ? " panel-error--center" : ""}`} role="alert">
        <strong>The {this.props.name} hit an error.</strong>
        <code>{this.state.error.message}</code>
        <small className="muted">The rest of the office still works. Details are in the browser console.</small>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => {
            this.setState({ error: null });
            this.props.onClose();
          }}
        >
          {this.props.action ?? "Close"}
        </button>
      </div>
    );
  }
}
