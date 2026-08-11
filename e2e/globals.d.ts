// Hooks the demo pages expose purely so the e2e suite can observe internal
// state. They exist on the demo pages only, never in the shipped package.
declare global {
  interface Window {
    __playingCount: () => number;
    __readyCount: (scope: string) => number;
    __eagerReadyAtSetup: number;
    __preloadCount: () => number;
    /** reveal-failsafe.html: the marked <img> itself. */
    __opacity: (id: string) => string;
    __isReady: (id: string) => boolean;
    __playing: () => boolean;
    /** art-directed.html: the <video> inside the box, not the box. */
    __videoOpacity: (id: string) => string;
    __posterVisible: (id: string) => boolean;
    __fadeDuration: (id: string) => string;
    __fills: (id: string) => { poster: boolean; video: boolean; objectFit: string };
    __marks: {
      ready: number | null;
      framesAtReveal: number | null;
      readyStateAtReveal: number | null;
    };
    __events: string[];
    /** warm.html: fixture URLs the browser has actually fetched. */
    __warmedUrls: () => string[];
    __state: () => {
      recoversSrc: string;
      recoversReady: boolean;
      exhaustsFailed: boolean;
    };
  }
}
export {};
