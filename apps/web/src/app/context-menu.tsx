import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { LiquidGlassBackdrop } from './liquid-glass-backdrop';

export type ContextMenuItemVariant = 'normal' | 'danger';

export interface ContextMenuItem<TContext> {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  variant?: ContextMenuItemVariant;
  disabled?: boolean;
  disabledReason?: string;
  hidden?: boolean;
  children?: ContextMenuItem<TContext>[];
  run?: (context: TContext) => void | Promise<void>;
}

export interface ContextMenuSection<TContext> {
  id: string;
  title?: string;
  items: ContextMenuItem<TContext>[];
}

export interface ContextMenuSnapshot<TContext> {
  x: number;
  y: number;
  context: TContext;
  sections: ContextMenuSection<TContext>[];
  sourceElement: HTMLElement | null;
}

export interface ContextMenuController<TContext> {
  menu: ContextMenuSnapshot<TContext> | null;
  open: (
    event: ReactMouseEvent<HTMLElement>,
    context: TContext,
    sections: ContextMenuSection<TContext>[],
  ) => void;
  close: () => void;
}

const MENU_MARGIN = 8;
const SUBMENU_GAP = 8;

export function clampMenuPosition(input: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}): { x: number; y: number } {
  const maxX = Math.max(MENU_MARGIN, input.viewportWidth - input.width - MENU_MARGIN);
  const maxY = Math.max(MENU_MARGIN, input.viewportHeight - input.height - MENU_MARGIN);
  return {
    x: Math.min(Math.max(MENU_MARGIN, input.x), maxX),
    y: Math.min(Math.max(MENU_MARGIN, input.y), maxY),
  };
}

function clampSubmenuPosition(input: {
  anchor: DOMRect;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}): { x: number; y: number } {
  const canOpenRight = input.anchor.right + SUBMENU_GAP + input.width <= input.viewportWidth - MENU_MARGIN;
  const preferredX = canOpenRight
    ? input.anchor.right + SUBMENU_GAP
    : input.anchor.left - SUBMENU_GAP - input.width;
  const maxX = Math.max(MENU_MARGIN, input.viewportWidth - input.width - MENU_MARGIN);
  const maxY = Math.max(MENU_MARGIN, input.viewportHeight - input.height - MENU_MARGIN);

  return {
    x: Math.min(Math.max(MENU_MARGIN, preferredX), maxX),
    y: Math.min(Math.max(MENU_MARGIN, input.anchor.top - 6), maxY),
  };
}

export function useContextMenu<TContext>(): ContextMenuController<TContext> {
  const [menu, setMenu] = useState<ContextMenuSnapshot<TContext> | null>(null);

  const close = useCallback(() => {
    setMenu((current) => {
      current?.sourceElement?.focus?.();
      return null;
    });
  }, []);

  const open = useCallback<ContextMenuController<TContext>['open']>((event, context, sections) => {
    event.preventDefault();
    event.stopPropagation();

    setMenu({
      x: event.clientX,
      y: event.clientY,
      context,
      sections,
      sourceElement: event.currentTarget,
    });
  }, []);

  return {
    menu,
    open,
    close,
  };
}

function visibleSections<TContext>(sections: ContextMenuSection<TContext>[]): ContextMenuSection<TContext>[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.hidden),
    }))
    .filter((section) => section.items.length > 0);
}

function firstRunnableIndex<TContext>(items: ContextMenuItem<TContext>[]): number {
  const index = items.findIndex((item) => !item.disabled);
  return index >= 0 ? index : 0;
}

function nextEnabledIndex<TContext>(
  items: ContextMenuItem<TContext>[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (items.length === 0) {
    return -1;
  }

  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (currentIndex + offset * direction + items.length) % items.length;
    if (!items[index]?.disabled) {
      return index;
    }
  }

  return currentIndex;
}

function getContextMenuKind(context: unknown): string | null {
  if (!context || typeof context !== 'object' || !('kind' in context)) {
    return null;
  }

  const kind = (context as { kind?: unknown }).kind;
  return typeof kind === 'string' && /^[a-z0-9_-]+$/i.test(kind) ? kind : null;
}

export function ContextMenuHost<TContext>({
  menu,
  onClose,
  overLight = false,
}: {
  menu: ContextMenuSnapshot<TContext> | null;
  onClose: () => void;
  overLight?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const submenuMenuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const submenuRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [submenuPosition, setSubmenuPosition] = useState({ x: 0, y: 0 });
  const [submenuPositionReady, setSubmenuPositionReady] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeSubmenuIndex, setActiveSubmenuIndex] = useState(0);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const sections = useMemo(() => visibleSections(menu?.sections ?? []), [menu?.sections]);
  const flatItems = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const openSubmenuIndex = useMemo(
    () => flatItems.findIndex((item) => item.id === openSubmenuId),
    [flatItems, openSubmenuId],
  );
  const openSubmenuItem = openSubmenuIndex >= 0 ? flatItems[openSubmenuIndex] : undefined;
  const activeSubmenuItems = useMemo(
    () => openSubmenuItem?.children?.filter((child) => !child.hidden) ?? [],
    [openSubmenuItem],
  );
  const menuKind = useMemo(() => getContextMenuKind(menu?.context), [menu?.context]);

  useEffect(() => {
    if (!menu) {
      return;
    }

    setPosition({ x: menu.x, y: menu.y });
    setActiveIndex(firstRunnableIndex(flatItems));
    setActiveSubmenuIndex(0);
    setOpenSubmenuId(null);
    setSubmenuPositionReady(false);
  }, [flatItems, menu]);

  useEffect(() => {
    if (!menu) {
      return;
    }

    const element = menuRef.current;
    if (!element) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const rect = element.getBoundingClientRect();
      setPosition(
        clampMenuPosition({
          x: menu.x,
          y: menu.y,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    });

    return () => window.cancelAnimationFrame(frame);
  }, [menu, sections]);

  useEffect(() => {
    if (!menu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      if (submenuMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      onClose();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menu, onClose]);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const button = itemRefs.current[activeIndex];
    button?.focus();
  }, [activeIndex, menu]);

  useEffect(() => {
    if (!menu || !openSubmenuId) {
      return;
    }
    const button = submenuRefs.current[activeSubmenuIndex];
    button?.focus();
  }, [activeSubmenuIndex, menu, openSubmenuId]);

  useEffect(() => {
    if (!menu || !openSubmenuId || activeSubmenuItems.length === 0 || openSubmenuIndex < 0) {
      setSubmenuPositionReady(false);
      return;
    }

    const anchor = itemRefs.current[openSubmenuIndex];
    const submenu = submenuMenuRef.current;
    if (!anchor || !submenu) {
      return;
    }

    const updatePosition = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const submenuRect = submenu.getBoundingClientRect();
      setSubmenuPosition(
        clampSubmenuPosition({
          anchor: anchorRect,
          width: submenuRect.width,
          height: submenuRect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
      setSubmenuPositionReady(true);
    };

    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [activeSubmenuItems.length, menu, openSubmenuId, openSubmenuIndex, position]);

  const runItem = useCallback(
    (item: ContextMenuItem<TContext>) => {
      if (!menu || item.disabled) {
        return;
      }
      const visibleChildren = item.children?.filter((child) => !child.hidden) ?? [];
      if (visibleChildren.length > 0) {
        setSubmenuPositionReady(false);
        setOpenSubmenuId((current) => (current === item.id ? null : item.id));
        setActiveSubmenuIndex(firstRunnableIndex(visibleChildren));
        return;
      }

      const actionContext = menu.context;
      onClose();
      void Promise.resolve()
        .then(() => item.run?.(actionContext));
    },
    [menu, onClose],
  );

  const onMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!menu || flatItems.length === 0) {
        return;
      }

      if (openSubmenuId && activeSubmenuItems.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActiveSubmenuIndex((current) => nextEnabledIndex(activeSubmenuItems, current, 1));
          return;
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActiveSubmenuIndex((current) => nextEnabledIndex(activeSubmenuItems, current, -1));
          return;
        }

        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setOpenSubmenuId(null);
          itemRefs.current[activeIndex]?.focus();
          return;
        }

        if (event.key === 'Enter' || event.key === ' ') {
          const activeSubmenuItem = activeSubmenuItems[activeSubmenuIndex];
          if (activeSubmenuItem) {
            event.preventDefault();
            runItem(activeSubmenuItem);
          }
          return;
        }
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => nextEnabledIndex(flatItems, current, 1));
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => nextEnabledIndex(flatItems, current, -1));
        return;
      }

      const activeItem = flatItems[activeIndex];
      if (!activeItem) {
        return;
      }

      const visibleChildren = activeItem.children?.filter((child) => !child.hidden) ?? [];
      if (event.key === 'ArrowRight' && visibleChildren.length > 0) {
        event.preventDefault();
        setSubmenuPositionReady(false);
        setOpenSubmenuId(activeItem.id);
        setActiveSubmenuIndex(firstRunnableIndex(visibleChildren));
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setOpenSubmenuId(null);
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        runItem(activeItem);
      }
    },
    [activeIndex, activeSubmenuIndex, activeSubmenuItems, flatItems, menu, openSubmenuId, runItem],
  );

  if (!menu || flatItems.length === 0) {
    return null;
  }

  let flatIndex = -1;

  return createPortal(
    <>
      <div
      ref={menuRef}
      className={`context-menu discord-context-menu liquid-surface ${menuKind ? `context-menu-${menuKind}` : ''} ${overLight ? 'over-light-background' : ''}`}
      style={{ top: position.y, left: position.x }}
      role="menu"
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={onMenuKeyDown}
      >
        <LiquidGlassBackdrop
        className="menu-liquid-glass"
        cornerRadius={14}
        displacementScale={72}
        blurAmount={0.14}
        saturation={148}
        aberrationIntensity={1.4}
        elasticity={0}
        mode="prominent"
        overLight={overLight}
        />
        {sections.map((section, sectionIndex) => (
          <div
          key={section.id}
          className={`context-menu-section ${section.title ? 'has-title' : ''}`}
          role="group"
          aria-labelledby={section.title ? `context-menu-title-${section.id}` : undefined}
        >
          {sectionIndex > 0 && !section.title && <div className="context-menu-separator" role="separator" />}
          {section.title && (
            <div className="context-menu-section-title glass-panel" id={`context-menu-title-${section.id}`}>
              <LiquidGlassBackdrop
                className="menu-title-liquid-glass"
                cornerRadius={999}
                displacementScale={58}
                blurAmount={0.1}
                saturation={145}
                aberrationIntensity={1.1}
                elasticity={0}
                mode="prominent"
                overLight={overLight}
                staticEffect
              />
              <span>{section.title}</span>
            </div>
          )}
          {section.items.map((item) => {
            flatIndex += 1;
            const itemIndex = flatIndex;
            const hasSubmenu = Boolean(item.children?.some((child) => !child.hidden));

            return (
              <div
                key={item.id}
                className="context-menu-row-wrap"
                onMouseEnter={() => {
                  setActiveIndex(itemIndex);
                  setActiveSubmenuIndex(0);
                  if (hasSubmenu) {
                    setSubmenuPositionReady(false);
                    setOpenSubmenuId(item.id);
                  } else {
                    setOpenSubmenuId(null);
                  }
                }}
              >
                <button
                  ref={(node) => {
                    itemRefs.current[itemIndex] = node;
                  }}
                  type="button"
                  className={`context-menu-item ${item.variant === 'danger' ? 'danger' : ''}`}
                  role="menuitem"
                  disabled={item.disabled}
                  title={item.disabled ? item.disabledReason : undefined}
                  onClick={() => runItem(item)}
                >
                  <span className="context-menu-icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="context-menu-label">{item.label}</span>
                  {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
                  {hasSubmenu && <span className="context-menu-caret" aria-hidden>›</span>}
                </button>
              </div>
            );
          })}
        </div>
      ))}
      </div>
      {openSubmenuId && activeSubmenuItems.length > 0 && (
        <div
          ref={submenuMenuRef}
          className={`context-submenu liquid-surface ${overLight ? 'over-light-background' : ''}`}
          style={{
            top: submenuPosition.y,
            left: submenuPosition.x,
            visibility: submenuPositionReady ? 'visible' : 'hidden',
          }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={onMenuKeyDown}
        >
          <LiquidGlassBackdrop
            className="menu-liquid-glass"
            cornerRadius={14}
            displacementScale={72}
            blurAmount={0.14}
            saturation={148}
            aberrationIntensity={1.4}
            elasticity={0}
            mode="prominent"
            overLight={overLight}
          />
          {activeSubmenuItems.map((child, childIndex) => (
            <button
              key={child.id}
              ref={(node) => {
                submenuRefs.current[childIndex] = node;
              }}
              type="button"
              className={`context-menu-item ${child.variant === 'danger' ? 'danger' : ''}`}
              role="menuitem"
              disabled={child.disabled}
              title={child.disabled ? child.disabledReason : undefined}
              onMouseEnter={() => setActiveSubmenuIndex(childIndex)}
              onClick={() => runItem(child)}
            >
              <span className="context-menu-icon" aria-hidden>{child.icon}</span>
              <span className="context-menu-label">{child.label}</span>
              {child.shortcut && <span className="context-menu-shortcut">{child.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </>,
    document.body,
  );
}
