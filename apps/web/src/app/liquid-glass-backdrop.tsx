import { type CSSProperties, type RefObject } from 'react';
import LiquidGlass from 'liquid-glass-react';

type LiquidGlassMode = 'standard' | 'polar' | 'prominent' | 'shader';

type LiquidGlassBackdropProps = {
  aberrationIntensity?: number;
  blurAmount?: number;
  className?: string;
  cornerRadius: number;
  displacementScale?: number;
  elasticity?: number;
  mode?: LiquidGlassMode;
  mouseContainer?: RefObject<HTMLElement | null>;
  overLight?: boolean;
  saturation?: number;
  staticEffect?: boolean;
};

const staticGlassMousePosition = { x: 0, y: 0 };

const liquidGlassLayerStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: '100%',
  height: '100%',
};

export function LiquidGlassBackdrop({
  aberrationIntensity = 2,
  blurAmount = 0.06,
  className = '',
  cornerRadius,
  displacementScale = 44,
  elasticity = 0.16,
  mode = 'standard',
  mouseContainer,
  overLight = false,
  saturation = 145,
  staticEffect = false,
}: LiquidGlassBackdropProps) {
  return (
    <span className={`liquid-glass-backdrop ${className} ${overLight ? 'over-light' : ''}`} aria-hidden="true">
      <LiquidGlass
        className="liquid-glass-layer"
        style={liquidGlassLayerStyle}
        padding="0"
        cornerRadius={cornerRadius}
        displacementScale={displacementScale}
        blurAmount={blurAmount}
        saturation={saturation}
        aberrationIntensity={aberrationIntensity}
        elasticity={elasticity}
        mode={mode}
        globalMousePos={staticEffect ? staticGlassMousePosition : undefined}
        mouseOffset={staticEffect ? staticGlassMousePosition : undefined}
        mouseContainer={mouseContainer}
        overLight={overLight}
      >
        <span className="liquid-glass-fill" />
      </LiquidGlass>
    </span>
  );
}
