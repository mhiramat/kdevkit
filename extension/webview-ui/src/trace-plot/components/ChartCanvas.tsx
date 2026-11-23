import type { ECharts, EChartsCoreOption } from 'echarts/core';
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { echarts, readVscodeChartTheme, TracePlotTheme } from '../echartsSetup';

export interface ChartCanvasHandle {
  getDataURL: (backgroundColor?: string) => string | null;
}

export interface ChartCanvasProps {
  option: EChartsCoreOption;
  onSelectEvent: (eventIndex: number) => void;
  onThemeChange?: (theme: TracePlotTheme) => void;
}

export const ChartCanvas = forwardRef<ChartCanvasHandle, ChartCanvasProps>(
  ({ option, onSelectEvent, onThemeChange }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<ECharts | null>(null);
    const onSelectRef = useRef(onSelectEvent);
    onSelectRef.current = onSelectEvent;

    useImperativeHandle(ref, () => ({
      getDataURL: (backgroundColor?: string) => {
        if (!chartRef.current) {
          return null;
        }
        return chartRef.current.getDataURL({
          type: 'png',
          pixelRatio: 2,
          backgroundColor: backgroundColor ?? readVscodeChartTheme().backgroundColor,
        });
      },
    }));

    useEffect(() => {
      const el = containerRef.current;
      if (!el) {
        return;
      }

      const instance = echarts.init(el, undefined, { renderer: 'canvas' });
      chartRef.current = instance;

      const handleClick = (params: any) => {
        if (Array.isArray(params?.value) && typeof params.value[2] === 'number') {
          onSelectRef.current(params.value[2]);
          return;
        }
        const indices = params?.data?.eventIndices;
        if (Array.isArray(indices) && indices.length > 0 && typeof indices[0] === 'number') {
          onSelectRef.current(indices[0]);
        }
      };

      instance.on('click', handleClick);

      const resizeObserver = new ResizeObserver(() => {
        instance.resize();
      });
      resizeObserver.observe(el);

      const themeObserver = new MutationObserver(() => {
        onThemeChange?.(readVscodeChartTheme());
      });
      if (document.body) {
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class'],
        });
      }

      return () => {
        themeObserver.disconnect();
        resizeObserver.disconnect();
        instance.off('click', handleClick);
        instance.dispose();
        chartRef.current = null;
      };
    }, [onThemeChange]);

    useEffect(() => {
      const instance = chartRef.current;
      if (!instance) {
        return;
      }
      instance.setOption(option, { notMerge: true, lazyUpdate: true });
    }, [option]);

    return <div ref={containerRef} className="tp-chart-canvas" />;
  }
);

ChartCanvas.displayName = 'ChartCanvas';
