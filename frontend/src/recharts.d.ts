declare module 'recharts' {
  export const ResponsiveContainer: any;
  export const BarChart: any;
  export const Bar: any;
  export const LineChart: any;
  export const Line: any;
  export const PieChart: any;
  export const Pie: any;
  export const XAxis: any;
  export const YAxis: any;
  export const CartesianGrid: any;
  export const Tooltip: any;
  export const Legend: any;
  export const Cell: any;

  // Add custom formatter type that aligns with what we're using
  export interface TooltipPayload {
    value: number;
    name: string;
    payload: any;
    dataKey: string;
    // other properties...
  }
}