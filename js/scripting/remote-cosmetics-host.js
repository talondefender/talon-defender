/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_remoteCosmeticsHost() {

const controller = self.TalonRemoteCosmeticsController;
const readiness = controller !== null &&
    typeof controller === 'object' &&
    typeof controller.install === 'function'
    ? Promise.resolve(controller.install({ scope: 'host' }))
    : Promise.reject(new Error('remote cosmetics controller unavailable'));
self.TalonRemoteCosmeticsHostReady = readiness;
readiness.catch(( ) => {});

})();

self.TalonRemoteCosmeticsHostReady;
