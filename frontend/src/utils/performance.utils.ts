// src/utils/performance.utils.ts
import React, { useEffect, useRef } from 'react';

export class PerformanceMonitor {
  private metrics = new Map<string, number[]>();

  startMeasurement(label: string): () => void {
    const start = performance.now();
    return () => {
      const end = performance.now();
      const duration = end - start;
      if (!this.metrics.has(label)) {
        this.metrics.set(label, []);
      }
      this.metrics.get(label)!.push(duration);
    };
  }

  getAverageTime(label: string): number {
    const measurements = this.metrics.get(label) || [];
    return measurements.length > 0 
      ? measurements.reduce((a, b) => a + b, 0) / measurements.length 
      : 0;
  }

  generateReport(): any {
    const report: any = {};
    this.metrics.forEach((measurements, label) => {
      report[label] = {
        average: this.getAverageTime(label),
        count: measurements.length,
        total: measurements.reduce((a, b) => a + b, 0)
      };
    });
    return report;
  }

  analyzePerformance(): any {
    const analysis: any = {
      slowQueries: [],
      recommendations: []
    };

    this.metrics.forEach((measurements, label) => {
      const avg = this.getAverageTime(label);
      if (avg > 1000) {
        analysis.slowQueries.push({ label, averageTime: avg });
      }
    });

    if (analysis.slowQueries.length > 0) {
      analysis.recommendations.push('Consider optimizing slow queries');
    }

    return analysis;
  }
}

export const performanceMonitor = new PerformanceMonitor();

export function withPerformanceMonitoring<T extends Record<string, any>>(
  Component: React.ComponentType<T>
): React.ComponentType<T> {
  return function PerformanceWrapper(props: T) {
    useEffect(() => {
      const endMeasurement = performanceMonitor.startMeasurement(Component.name);
      return endMeasurement;
    }, []);

    return React.createElement(Component, props);
  };
}

export function useRenderCount() {
  const renderCount = useRef(0);
  const renderTimes = useRef<number[]>([]);

  useEffect(() => {
    renderCount.current += 1;
    renderTimes.current.push(Date.now());
  });

  return {
    count: renderCount.current,
    times: renderTimes.current
  };
}

export default performanceMonitor;
