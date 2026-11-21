export interface ActionState {
  error: string;
  errorStale: boolean;
  busy: boolean;
}

export type ActionEvent =
  | { type: 'start' }
  | { type: 'succeed' }
  | { type: 'fail'; error: string }
  | { type: 'set-error'; error: string };

export const INITIAL_ACTION_STATE: ActionState = {
  error: '',
  errorStale: false,
  busy: false,
};

/**
 * Pure state transition for `useAction` (S2): keeps any existing error visible
 * and marks it `errorStale: true` while a retry is in flight so inline notices
 * do not collapse and bounce the form vertically.
 */
export function reduceActionState(state: ActionState, event: ActionEvent): ActionState {
  switch (event.type) {
    case 'start':
      return {
        error: state.error,
        errorStale: state.error.length > 0,
        busy: true,
      };
    case 'succeed':
      return {
        error: '',
        errorStale: false,
        busy: false,
      };
    case 'fail':
      return {
        error: event.error,
        errorStale: false,
        busy: false,
      };
    case 'set-error':
      return {
        ...state,
        error: event.error,
        errorStale: false,
      };
  }
}
