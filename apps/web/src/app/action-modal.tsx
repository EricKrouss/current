import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LiquidGlassBackdrop } from './liquid-glass-backdrop';

type ModalVariant = 'normal' | 'danger';

interface BaseModalDescriptor<TResult> {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ModalVariant;
  resolve: (result: TResult) => void;
}

interface ConfirmModalDescriptor extends BaseModalDescriptor<boolean> {
  kind: 'confirm';
}

interface TextModalDescriptor extends BaseModalDescriptor<string | null> {
  kind: 'text';
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
}

interface ModerationModalDescriptor extends BaseModalDescriptor<ModerationModalResult | null> {
  kind: 'moderation';
  defaultReason?: string;
  defaultTimeoutMinutes?: number;
  includeTimeout?: boolean;
}

interface InfoModalDescriptor extends BaseModalDescriptor<void> {
  kind: 'info';
}

type ActionModalDescriptor =
  | ConfirmModalDescriptor
  | TextModalDescriptor
  | ModerationModalDescriptor
  | InfoModalDescriptor;

export interface ModerationModalResult {
  reason: string;
  timeoutMinutes?: number;
}

export interface ActionModalController {
  modal: ActionModalDescriptor | null;
  confirm: (input: Omit<ConfirmModalDescriptor, 'kind' | 'resolve'>) => Promise<boolean>;
  textInput: (input: Omit<TextModalDescriptor, 'kind' | 'resolve'>) => Promise<string | null>;
  moderation: (input: Omit<ModerationModalDescriptor, 'kind' | 'resolve'>) => Promise<ModerationModalResult | null>;
  info: (input: Omit<InfoModalDescriptor, 'kind' | 'resolve'>) => void;
  close: (resolveDismissal?: boolean) => void;
}

export function useActionModal(): ActionModalController {
  const [modal, setModal] = useState<ActionModalDescriptor | null>(null);

  const close = useCallback<ActionModalController['close']>((resolveDismissal = true) => {
    setModal((current) => {
      if (!resolveDismissal) {
        return null;
      }

      if (current?.kind === 'confirm') {
        current.resolve(false);
      } else if (current?.kind === 'text') {
        current.resolve(null);
      } else if (current?.kind === 'moderation') {
        current.resolve(null);
      } else if (current?.kind === 'info') {
        current.resolve();
      }
      return null;
    });
  }, []);

  const confirm = useCallback<ActionModalController['confirm']>((input) => {
    return new Promise<boolean>((resolve) => {
      setModal({
        ...input,
        kind: 'confirm',
        resolve,
      });
    });
  }, []);

  const textInput = useCallback<ActionModalController['textInput']>((input) => {
    return new Promise<string | null>((resolve) => {
      setModal({
        ...input,
        kind: 'text',
        resolve,
      });
    });
  }, []);

  const moderation = useCallback<ActionModalController['moderation']>((input) => {
    return new Promise<ModerationModalResult | null>((resolve) => {
      setModal({
        ...input,
        kind: 'moderation',
        resolve,
      });
    });
  }, []);

  const info = useCallback<ActionModalController['info']>((input) => {
    setModal({
      ...input,
      kind: 'info',
      resolve: () => undefined,
    });
  }, []);

  return {
    modal,
    confirm,
    textInput,
    moderation,
    info,
    close,
  };
}

export function ActionModalHost({
  modal,
  onClose,
  overLight = false,
}: {
  modal: ActionModalDescriptor | null;
  onClose: (resolveDismissal?: boolean) => void;
  overLight?: boolean;
}) {
  const modalGlassRef = useRef<HTMLFormElement | null>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [timeoutMinutes, setTimeoutMinutes] = useState(10);

  useEffect(() => {
    if (!modal) {
      return;
    }

    if (modal.kind === 'text') {
      setValue(modal.defaultValue ?? '');
    }

    if (modal.kind === 'moderation') {
      setReason(modal.defaultReason ?? '');
      setTimeoutMinutes(modal.defaultTimeoutMinutes ?? 10);
    }
  }, [modal]);

  useEffect(() => {
    if (!modal) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [modal, onClose]);

  if (!modal) {
    return null;
  }

  const resolveAndClose = () => {
    if (modal.kind === 'confirm') {
      modal.resolve(true);
    } else if (modal.kind === 'text') {
      const nextValue = value.trim();
      if (modal.required && nextValue.length === 0) {
        return;
      }
      modal.resolve(nextValue);
    } else if (modal.kind === 'moderation') {
      modal.resolve({
        reason: reason.trim() || modal.defaultReason || 'No reason provided',
        timeoutMinutes: modal.includeTimeout ? timeoutMinutes : undefined,
      });
    } else {
      modal.resolve();
    }
    onClose(false);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    resolveAndClose();
  };

  return createPortal(
    <div className="action-modal-backdrop" onClick={() => onClose()}>
      <form
        ref={modalGlassRef}
        className={`action-modal liquid-surface ${overLight ? 'over-light-background' : ''} ${modal.variant === 'danger' ? 'danger' : ''}`}
        onSubmit={onSubmit}
        onClick={(event) => event.stopPropagation()}
      >
        <LiquidGlassBackdrop
          className="modal-liquid-glass"
          cornerRadius={18}
          displacementScale={128}
          blurAmount={0.12}
          saturation={145}
          aberrationIntensity={2}
          elasticity={0.04}
          mode="prominent"
          mouseContainer={modalGlassRef}
          overLight={overLight}
        />
        <header className="action-modal-header">
          <h3>{modal.title}</h3>
          <button type="button" className="action-modal-close" onClick={() => onClose()} aria-label="Close">
            ×
          </button>
        </header>
        {modal.message && <p className="action-modal-message">{modal.message}</p>}

        {modal.kind === 'text' && (
          modal.multiline ? (
            <textarea
              className="action-modal-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={modal.placeholder}
              autoFocus
            />
          ) : (
            <input
              className="action-modal-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={modal.placeholder}
              autoFocus
            />
          )
        )}

        {modal.kind === 'moderation' && (
          <div className="action-modal-grid">
            <label>
              Reason
              <textarea
                className="action-modal-input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Reason"
                autoFocus
              />
            </label>
            {modal.includeTimeout && (
              <label>
                Timeout minutes
                <input
                  className="action-modal-input"
                  type="number"
                  min={1}
                  max={10080}
                  value={timeoutMinutes}
                  onChange={(event) => setTimeoutMinutes(Number(event.target.value))}
                />
              </label>
            )}
          </div>
        )}

        <footer className="action-modal-footer">
          {modal.kind !== 'info' && (
            <button type="button" className="action-modal-secondary" onClick={() => onClose()}>
              {modal.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button type="submit" className={`action-modal-primary ${modal.variant === 'danger' ? 'danger' : ''}`}>
            {modal.confirmLabel ?? (modal.kind === 'info' ? 'Done' : 'Confirm')}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
