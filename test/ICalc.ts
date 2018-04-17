export interface ICalc {
  add(x: number, y: number): number;
}

export interface IScopedCalc {
  add(scope: string, x: number, y: number): number;
}
