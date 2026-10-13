import { X } from 'lucide-react';
import { useCallback, useRef, type ComponentProps } from 'react';
import { HoverTooltip } from './HoverTooltip';
import './clearable.css';

/** A filter box with a clear (×) button inside its right edge, there while it has text. The space
 *  for it is always reserved, so typing doesn't shift the text. The button never takes the focus:
 *  it clears and leaves the caret in the box (Esc, or select-all and delete, clear it from the
 *  keyboard). `boxClassName` goes on the wrapper, which takes the input's place in the layout. */
export function ClearableInput({ ref, onClear, boxClassName, style, ...props }: ComponentProps<'input'> & { value: string; onClear(): void; boxClassName?: string }) {
  const own = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback((el: HTMLInputElement | null) => {
    own.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  }, [ref]);
  return (
    <span className={`clearable${boxClassName ? ` ${boxClassName}` : ''}`}>
      <input ref={setRef} {...props} style={{ ...style, paddingRight: 24 }} />
      {props.value !== '' && (
        <HoverTooltip content="Clear filter">
          <button
            type="button"
            className="clearable-clear"
            aria-label="Clear filter"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onClear(); own.current?.focus(); }}
          >
            <X size={12} aria-hidden />
          </button>
        </HoverTooltip>
      )}
    </span>
  );
}
