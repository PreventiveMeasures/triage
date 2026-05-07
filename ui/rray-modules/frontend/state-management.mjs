import { observable, observe, unobserve } from '@nx-js/observer-util/dist/es.es6.js';

const store = observable;

function autorun(method) {
  let first = true;
  const reaction = observe(() => {
    method(first);
    first = false;
  });
  return () => unobserve(reaction);
}

function autopromise(condition) {
  let abort;
  let dispose;
  const promise = new Promise((resolve, reject) => {
    abort = reject;
    dispose = autorun(first => {
      const result = condition(first);
      if (result) resolve(result);
    });
  });
  promise.abort = abort;
  promise.finally(dispose);
  return promise;
}

export { store, autorun, autopromise };
