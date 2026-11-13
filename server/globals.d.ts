/** Ambient declarations for the FiveM server natives and runtime globals this resource calls. */

declare function GetConvar(name: string, defaultValue: string): string;
declare function GetCurrentResourceName(): string;
declare function GetResourcePath(resourceName: string): string;
declare function GetResourceState(resourceName: string): string;
declare function GetResourceMetadata(resourceName: string, key: string, index: number): string;

declare function GetPlayerPed(playerSource: string): number;
declare function GetEntityCoords(entity: number): [number, number, number];

declare function on(eventName: string, callback: (...args: unknown[]) => void): void;
declare function emit(eventName: string, ...args: unknown[]): void;

/** `restricted: true` keeps a command off the chat box and on the server console. */
declare function RegisterCommand(
  name: string,
  handler: (source: number, args: string[], raw: string) => void,
  restricted: boolean
): void;

declare function IsDuplicityVersion(): boolean;
