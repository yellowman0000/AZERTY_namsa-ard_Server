import { VERSION_NEUTRAL, VersioningType } from '@nestjs/common';
import { isRouteExcluded } from '../router/utils/index.js';
import { RoutePathFactory } from './../router/route-path-factory.js';
import { addLeadingSlash, stripEndSlash, } from '@nestjs/common/internal';
export class RouteInfoPathExtractor {
    applicationConfig;
    routePathFactory;
    prefixPath;
    excludedGlobalPrefixRoutes;
    versioningConfig;
    constructor(applicationConfig) {
        this.applicationConfig = applicationConfig;
        this.routePathFactory = new RoutePathFactory(applicationConfig);
        this.prefixPath = stripEndSlash(addLeadingSlash(this.applicationConfig.getGlobalPrefix()));
        this.excludedGlobalPrefixRoutes =
            this.applicationConfig.getGlobalPrefixOptions().exclude;
        this.versioningConfig = this.applicationConfig.getVersioning();
    }
    extractPathsFrom({ path, method, version }) {
        const versionPaths = this.extractVersionPathFrom(version);
        if (this.isAWildcard(path)) {
            // VERSION_NEUTRAL has no version segment, so its wildcard already covers
            // every versioned path; registering both would run the middleware twice.
            const wildcardVersionPaths = versionPaths.includes('')
                ? []
                : versionPaths;
            const entries = wildcardVersionPaths.length > 0
                ? wildcardVersionPaths
                    .map(versionPath => [
                    this.prefixPath + versionPath + '$',
                    this.prefixPath + versionPath + addLeadingSlash(path),
                ])
                    .flat()
                : this.prefixPath
                    ? [this.prefixPath + '$', this.prefixPath + addLeadingSlash(path)]
                    : [addLeadingSlash(path)];
            return Array.isArray(this.excludedGlobalPrefixRoutes)
                ? [
                    ...entries,
                    ...this.excludedGlobalPrefixRoutes
                        .map(route => Array.isArray(versionPaths) && versionPaths.length > 0
                        ? versionPaths.map(v => v + addLeadingSlash(route.path))
                        : addLeadingSlash(route.path))
                        .flat(),
                ]
                : entries;
        }
        return this.extractNonWildcardPathsFrom({ path, method, version });
    }
    extractPathFrom(route) {
        if (this.isAWildcard(route.path) && !route.version) {
            return [addLeadingSlash(route.path)];
        }
        return this.extractNonWildcardPathsFrom(route);
    }
    isAWildcard(path) {
        const isSimpleWildcard = ['*', '/*', '/*/', '(.*)', '/(.*)'];
        if (isSimpleWildcard.includes(path)) {
            return true;
        }
        const wildcardRegexp = /^\/\{.*\}.*|^\/\*.*$/;
        return wildcardRegexp.test(path);
    }
    extractNonWildcardPathsFrom({ path, method, version, }) {
        const versionPaths = this.extractVersionPathFrom(version);
        if (Array.isArray(this.excludedGlobalPrefixRoutes) &&
            isRouteExcluded(this.excludedGlobalPrefixRoutes, path, method)) {
            if (!versionPaths.length) {
                return [addLeadingSlash(path)];
            }
            return versionPaths.map(versionPath => versionPath + addLeadingSlash(path));
        }
        if (!versionPaths.length) {
            return [this.prefixPath + addLeadingSlash(path)];
        }
        return versionPaths.map(versionPath => this.prefixPath + versionPath + addLeadingSlash(path));
    }
    extractVersionPathFrom(versionValue) {
        if (!versionValue || this.versioningConfig?.type !== VersioningType.URI)
            return [];
        const versionPrefix = this.routePathFactory.getVersionPrefix(this.versioningConfig);
        const toVersionPath = (version) => version === VERSION_NEUTRAL
            ? ''
            : addLeadingSlash(versionPrefix + version);
        if (Array.isArray(versionValue)) {
            return versionValue.map(toVersionPath);
        }
        return [toVersionPath(versionValue)];
    }
}
