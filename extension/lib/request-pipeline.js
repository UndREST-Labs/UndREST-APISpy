// lib/request-pipeline.js — shared request classification for panel and sweep

"use strict";

(function (exports) {

  async function classifyRequest(norm, scope) {
    if (!scope.inScope) {
      return {
        result: Matcher.classify(norm, null, { inScope: false }),
        packId: null,
      };
    }
    if (!norm.ok) {
      return {
        result: Matcher.classify(norm, null, { inScope: true }),
        packId: null,
      };
    }

    const providerNamespace = Matcher.inferProviderNamespace(norm.pathname);
    const isProviderlessArmRoot =
      !providerNamespace && Matcher.isArmRootPath(norm);
    let shard = null;
    let shardLoadError = null;
    let packId = null;

    if (!isProviderlessArmRoot) {
      try {
        const manifest = await Loader.loadManifest();
        const shardSource = Loader.findShardEntryForRequest(
          manifest,
          providerNamespace,
          norm.host
        );
        if (shardSource) {
          packId = shardSource.pack ? shardSource.pack.pack_id : null;
          shard = await Loader.loadShardEntry(shardSource.entry);
        }
      } catch (err) {
        shardLoadError = err && err.message ? err.message : String(err);
      }
    }

    return {
      result: Matcher.classify(norm, shard, {
        inScope: true,
        shardLoadError,
      }),
      packId,
    };
  }

  function shouldRetain(result, norm) {
    return result.provider_namespace !== null ||
      result.status === Matcher.STATUS.ARM_ROOT_ROUTE ||
      (norm.ok && Normalizer.isMicrosoftGraphHost(norm.host));
  }

  exports.RequestPipeline = {
    classifyRequest,
    shouldRetain,
  };

}(typeof window !== "undefined" ? window : exports));
