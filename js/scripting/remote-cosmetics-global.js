/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_remoteCosmeticsGlobal() {

const controller = self.TalonRemoteCosmeticsController;
const readiness = controller !== null &&
    typeof controller === 'object' &&
    typeof controller.install === 'function'
    ? Promise.resolve(controller.install({ scope: 'global' }))
    : Promise.reject(new Error('remote cosmetics controller unavailable'));
self.TalonRemoteCosmeticsGlobalReady = readiness;
readiness.catch(( ) => {});

})();

self.TalonRemoteCosmeticsGlobalReady;
