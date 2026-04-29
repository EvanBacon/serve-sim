// Protocol types for the device gateway wire protocol.

export interface ExecMessage {
  type: "exec";
  id: string;
  command: string;
  args: string[];
}

export interface FileWriteMessage {
  type: "file:write";
  id: string;
  path: string;
  data: string;
  final: boolean;
}

export interface FileReadMessage {
  type: "file:read";
  id: string;
  path: string;
}

export type ClientMessage = ExecMessage | FileWriteMessage | FileReadMessage;

export interface ExecStdoutMessage {
  type: "exec:stdout";
  id: string;
  data: string;
}

export interface ExecStderrMessage {
  type: "exec:stderr";
  id: string;
  data: string;
}

export interface ExecDoneMessage {
  type: "exec:done";
  id: string;
  exitCode: number;
}

export interface ExecErrorMessage {
  type: "exec:error";
  id: string;
  error: string;
}

export interface FileDataMessage {
  type: "file:data";
  id: string;
  data: string;
}

export interface FileDoneMessage {
  type: "file:done";
  id: string;
}

export interface FileErrorMessage {
  type: "file:error";
  id: string;
  error: string;
}

export type ServerMessage =
  | ExecStdoutMessage
  | ExecStderrMessage
  | ExecDoneMessage
  | ExecErrorMessage
  | FileDataMessage
  | FileDoneMessage
  | FileErrorMessage;
