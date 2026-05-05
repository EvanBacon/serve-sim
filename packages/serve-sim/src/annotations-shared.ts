/**
 * Comment annotations — shared types between server, middleware, and client.
 *
 * An Annotation is a single user-authored comment anchored to a point on the
 * simulator preview. The `context` block is best-effort: PR1 fills only the
 * fields the AX (Accessibility) snapshot can give us. Future PRs (DevTools
 * backend, react-native-grab) will populate componentName / sourceFile / etc.
 */

export type AnnotationStatus = "pending" | "sent" | "archived";

export interface AnnotationPoint {
  /** x in simulator point space (NOT browser pixels). */
  x: number;
  /** y in simulator point space. */
  y: number;
}

export interface AnnotationRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnnotationContext {
  /** Component name from React DevTools / react-native-grab. */
  componentName?: string;
  /** Absolute or cwd-relative source path. */
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
  /** Accessibility label resolved via the AX (axe) snapshot. */
  accessibilityLabel?: string;
  /** Accessibility role (button, link, image, ...). */
  accessibilityRole?: string;
  /** AX type (UIA element type). */
  accessibilityType?: string;
  /** AXUniqueId when present, otherwise the AX path. */
  accessibilityId?: string;
  /** Native view ID (Fabric ShadowTree). */
  nativeId?: string;
  /** Shallow snapshot of relevant props. Functions stripped before save. */
  props?: Record<string, unknown>;
}

export interface AnnotationDevice {
  udid: string;
  name: string;
}

export interface Annotation {
  id: string;
  createdAt: string;
  device: AnnotationDevice;
  point: AnnotationPoint;
  region?: AnnotationRegion;
  /** Relative path from the annotations dir to the JPEG crop. */
  screenshotPath: string;
  /** Relative path to the full-frame JPEG, when captured. */
  fullFramePath?: string;
  context?: AnnotationContext;
  comment: string;
  status: AnnotationStatus;
}

/** Body shape the client POSTs to create an annotation. */
export interface AnnotationCreateRequest {
  device: AnnotationDevice;
  point: AnnotationPoint;
  region?: AnnotationRegion;
  context?: AnnotationContext;
  comment: string;
  /** data:image/jpeg;base64,... — required. */
  cropDataUri: string;
  /** Optional full-frame data URI. */
  fullFrameDataUri?: string;
}

export interface AnnotationUpdateRequest {
  comment?: string;
  status?: AnnotationStatus;
}
