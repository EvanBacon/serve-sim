export interface AxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AxElement {
  id: string;
  path: string;
  label: string;
  value: string;
  role: string;
  type: string;
  enabled: boolean;
  frame: AxRect;
}

export interface AxSnapshot {
  screen: { width: number; height: number };
  elements: AxElement[];
  errors?: string[];
}
