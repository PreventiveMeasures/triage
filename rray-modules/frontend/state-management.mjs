import { observable, observe, unobserve } from '@nx-js/observer-util/dist/es.es6.js';

const store = observable;

function autorun(method) {
  let first = true;
  const reaction = observe(() => {
    try {
      method(first);
    } finally {
      first = false;
    }
  }, { lazy: true });
  try {
    reaction();
  } catch (err) {
    unobserve(reaction);
    throw err;
  }
  return () => unobserve(reaction);
}

function autopromise(condition) {
  let abort;
  let dispose;
  let resolved = false;
  const promise = new Promise((resolve, reject) => {
    abort = reject;
    try {
      dispose = autorun(first => {
        if (resolved) return;
        const result = condition(first);
        if (!result) return;
        resolved = true;
        resolve(result);
        if (dispose) dispose();
      });
    } catch (err) {
      reject(err);
      return;
    }
    if (resolved) dispose();
  });
  promise.abort = abort;
  return promise;
}

export { store, autorun, autopromise };
