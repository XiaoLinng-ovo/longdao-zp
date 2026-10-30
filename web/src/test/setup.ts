// jsdom does not implement layout scrolling, while vue-router invokes
// window.scrollTo for scrollBehavior during navigation. Keep tests focused
// on routing behavior without emitting environment warnings.
if (typeof window !== 'undefined') {
  window.scrollTo = (() => undefined) as typeof window.scrollTo
}
