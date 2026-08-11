// Hooks the demo pages expose purely so the e2e suite can observe internal
// state. They exist on the demo pages only, never in the shipped package.
declare global {
  interface Window {
    __playingCount: () => number;
    __readyCount: (scope: string) => number;
    __eagerReadyAtSetup: number;
    __preloadCount: () => number;
    __opacity: (id: string) => string;
    __isReady: (id: string) => boolean;
    __playing: () => boolean;
    __marks: {
      ready: number | null;
      framesAtReveal: number | null;
      readyStateAtReveal: number | null;
    };
    __events: string[];
    __state: () => {
      recoversSrc: string;
      recoversReady: boolean;
      exhaustsFailed: boolean;
    };
  }
}
export {};
