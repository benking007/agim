#!/usr/bin/env node
/**
 * Minimal Xcode project generator for Agim iOS (no XcodeGen required).
 * Produces Agim.xcodeproj/project.pbxproj so the app can be opened on a Mac.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const agimDir = path.join(root, 'Agim')
const testsDir = path.join(root, 'AgimTests')

function walk(dir, pred = () => true) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(p, pred))
    else if (pred(p)) out.push(p)
  }
  return out
}

function id(seed) {
  return crypto.createHash('md5').update(seed).digest('hex').slice(0, 24).toUpperCase()
}

const sources = walk(agimDir, (p) => /\.(swift|plist)$/.test(p) || p.endsWith('Contents.json'))
  .map((p) => path.relative(root, p))
  .sort()
const tests = walk(testsDir, (p) => p.endsWith('.swift'))
  .map((p) => path.relative(root, p))
  .sort()

const projectId = id('project')
const mainGroup = id('mainGroup')
const products = id('products')
const agimGroup = id('agimGroup')
const testsGroup = id('testsGroup')
const sourcesBuild = id('sourcesBuild')
const resourcesBuild = id('resourcesBuild')
const testsBuild = id('testsBuild')
const frameworksBuild = id('frameworksBuild')
const agimTarget = id('agimTarget')
const testsTarget = id('testsTarget')
const agimProduct = id('agimProduct')
const testsProduct = id('testsProduct')
const debugConf = id('debugConf')
const releaseConf = id('releaseConf')
const projectDebug = id('projectDebug')
const projectRelease = id('projectRelease')
const targetDebug = id('targetDebug')
const targetRelease = id('targetRelease')
const testsDebug = id('testsDebug')
const testsRelease = id('testsRelease')
const projectConfs = id('projectConfs')
const targetConfs = id('targetConfs')
const testsConfs = id('testsConfs')

const fileRefs = {}
const buildFiles = {}
for (const rel of [...sources, ...tests]) {
  fileRefs[rel] = id(`file:${rel}`)
  buildFiles[rel] = id(`build:${rel}`)
}

function groupChildren(prefix, files) {
  // Flat group listing is fine for MVP.
  return files.filter((f) => f.startsWith(prefix)).map((f) => fileRefs[f])
}

const swiftSources = sources.filter((f) => f.endsWith('.swift'))
const resourceFiles = sources.filter((f) => f.includes('Assets.xcassets') || f.endsWith('Contents.json'))
// Asset catalog: reference the .xcassets directory once
const assetsRel = 'Agim/Resources/Assets.xcassets'
const assetsRef = id('assets')
const assetsBuild = id('assetsBuild')

let pbx = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {

/* Begin PBXBuildFile section */
`
for (const rel of swiftSources) {
  pbx += `\t\t${buildFiles[rel]} /* ${path.basename(rel)} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRefs[rel]} /* ${path.basename(rel)} */; };\n`
}
pbx += `\t\t${assetsBuild} /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = ${assetsRef} /* Assets.xcassets */; };\n`
for (const rel of tests) {
  pbx += `\t\t${buildFiles[rel]} /* ${path.basename(rel)} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRefs[rel]} /* ${path.basename(rel)} */; };\n`
}
pbx += `/* End PBXBuildFile section */

/* Begin PBXFileReference section */
\t\t${agimProduct} /* Agim.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Agim.app; sourceTree = BUILT_PRODUCTS_DIR; };
\t\t${testsProduct} /* AgimTests.xctest */ = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = AgimTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
`
for (const rel of [...swiftSources, ...tests]) {
  pbx += `\t\t${fileRefs[rel]} /* ${path.basename(rel)} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${JSON.stringify(path.basename(rel))}; sourceTree = "<group>"; };\n`
}
pbx += `\t\t${assetsRef} /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };
\t\t${id('info')} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
`
const infoRef = id('info')
pbx += `/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
\t\t${frameworksBuild} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t${mainGroup} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${agimGroup} /* Agim */,
\t\t\t\t${testsGroup} /* AgimTests */,
\t\t\t\t${products} /* Products */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${products} /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${agimProduct} /* Agim.app */,
\t\t\t\t${testsProduct} /* AgimTests.xctest */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${agimGroup} /* Agim */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${swiftSources.map((rel) => `\t\t\t\t${fileRefs[rel]} /* ${path.basename(rel)} */,`).join('\n')}
\t\t\t\t${assetsRef} /* Assets.xcassets */,
\t\t\t\t${infoRef} /* Info.plist */,
\t\t\t);
\t\t\tpath = Agim;
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${testsGroup} /* AgimTests */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${tests.map((rel) => `\t\t\t\t${fileRefs[rel]} /* ${path.basename(rel)} */,`).join('\n')}
\t\t\t);
\t\t\tpath = AgimTests;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${agimTarget} /* Agim */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${targetConfs} /* Build configuration list for PBXNativeTarget "Agim" */;
\t\t\tbuildPhases = (
\t\t\t\t${sourcesBuild} /* Sources */,
\t\t\t\t${frameworksBuild} /* Frameworks */,
\t\t\t\t${resourcesBuild} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = Agim;
\t\t\tproductName = Agim;
\t\t\tproductReference = ${agimProduct} /* Agim.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
\t\t${testsTarget} /* AgimTests */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${testsConfs} /* Build configuration list for PBXNativeTarget "AgimTests" */;
\t\t\tbuildPhases = (
\t\t\t\t${testsBuild} /* Sources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t\t${id('dep')} /* PBXTargetDependency */,
\t\t\t);
\t\t\tname = AgimTests;
\t\t\tproductName = AgimTests;
\t\t\tproductReference = ${testsProduct} /* AgimTests.xctest */;
\t\t\tproductType = "com.apple.product-type.bundle.unit-test";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXTargetDependency section */
\t\t${id('dep')} /* PBXTargetDependency */ = {
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = ${agimTarget} /* Agim */;
\t\t\ttargetProxy = ${id('proxy')} /* PBXContainerItemProxy */;
\t\t};
/* End PBXTargetDependency section */

/* Begin PBXContainerItemProxy section */
\t\t${id('proxy')} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = ${projectId} /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${agimTarget};
\t\t\tremoteInfo = Agim;
\t\t};
/* End PBXContainerItemProxy section */

/* Begin PBXProject section */
\t\t${projectId} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastSwiftUpdateCheck = 1600;
\t\t\t\tLastUpgradeCheck = 1600;
\t\t\t\tTargetAttributes = {
\t\t\t\t\t${agimTarget} = {
\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;
\t\t\t\t\t};
\t\t\t\t\t${testsTarget} = {
\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;
\t\t\t\t\t\tTestTargetID = ${agimTarget};
\t\t\t\t\t};
\t\t\t\t};
\t\t\t};
\t\t\tbuildConfigurationList = ${projectConfs} /* Build configuration list for PBXProject "Agim" */;
\t\t\tcompatibilityVersion = "Xcode 15.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (
\t\t\t\ten,
\t\t\t\tBase,
\t\t\t);
\t\t\tmainGroup = ${mainGroup};
\t\t\tproductRefGroup = ${products} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${agimTarget} /* Agim */,
\t\t\t\t${testsTarget} /* AgimTests */,
\t\t\t);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t${resourcesBuild} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${assetsBuild} /* Assets.xcassets in Resources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
\t\t${sourcesBuild} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${swiftSources.map((rel) => `\t\t\t\t${buildFiles[rel]} /* ${path.basename(rel)} in Sources */,`).join('\n')}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
\t\t${testsBuild} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${tests.map((rel) => `\t\t\t\t${buildFiles[rel]} /* ${path.basename(rel)} in Sources */,`).join('\n')}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
\t\t${projectDebug} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCOPY_PHASE_STRIP = NO;
\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;
\t\t\t\tGCC_DYNAMIC_NO_PIC = NO;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;
\t\t\t\tONLY_ACTIVE_ARCH = YES;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)";
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${projectRelease} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCOPY_PHASE_STRIP = NO;
\t\t\t\tDEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_COMPILATION_MODE = wholemodule;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tVALIDATE_PRODUCT = YES;
\t\t\t};
\t\t\tname = Release;
\t\t};
\t\t${targetDebug} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tDEVELOPMENT_TEAM = "";
\t\t\t\tENABLE_PREVIEWS = YES;
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = Agim/Info.plist;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (
\t\t\t\t\t"$(inherited)",
\t\t\t\t\t"@executable_path/Frameworks",
\t\t\t\t);
\t\t\t\tMARKETING_VERSION = 0.1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = host.iclaw.agim;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
\t\t\t\tSUPPORTS_MACCATALYST = NO;
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = 1;
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${targetRelease} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tDEVELOPMENT_TEAM = "";
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = Agim/Info.plist;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (
\t\t\t\t\t"$(inherited)",
\t\t\t\t\t"@executable_path/Frameworks",
\t\t\t\t);
\t\t\t\tMARKETING_VERSION = 0.1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = host.iclaw.agim;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
\t\t\t\tSUPPORTS_MACCATALYST = NO;
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = 1;
\t\t\t};
\t\t\tname = Release;
\t\t};
\t\t${testsDebug} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tBUNDLE_LOADER = "$(TEST_HOST)";
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tGENERATE_INFOPLIST_FILE = YES;
\t\t\t\tMARKETING_VERSION = 0.1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = host.iclaw.agim.tests;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = 1;
\t\t\t\tTEST_HOST = "$(BUILT_PRODUCTS_DIR)/Agim.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/Agim";
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${testsRelease} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tBUNDLE_LOADER = "$(TEST_HOST)";
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tGENERATE_INFOPLIST_FILE = YES;
\t\t\t\tMARKETING_VERSION = 0.1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = host.iclaw.agim.tests;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = 1;
\t\t\t\tTEST_HOST = "$(BUILT_PRODUCTS_DIR)/Agim.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/Agim";
\t\t\t};
\t\t\tname = Release;
\t\t};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t${projectConfs} /* Build configuration list for PBXProject "Agim" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${projectDebug} /* Debug */,
\t\t\t\t${projectRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\t${targetConfs} /* Build configuration list for PBXNativeTarget "Agim" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${targetDebug} /* Debug */,
\t\t\t\t${targetRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\t${testsConfs} /* Build configuration list for PBXNativeTarget "AgimTests" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${testsDebug} /* Debug */,
\t\t\t\t${testsRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */
	};
	rootObject = ${projectId} /* Project object */;
}
`

// Fix file paths: all swift files are listed flat under Agim group but they live in subdirs.
// Xcode needs either nested groups or path including subdirs. Rebuild file refs with relative path from group.

function rewriteWithNestedPaths() {
  // Simpler approach: put each file's `path` as relative from Agim/ or AgimTests/
  let out = pbx
  for (const rel of swiftSources) {
    const base = path.basename(rel)
    const sub = rel.replace(/^Agim\//, '')
    if (sub !== base) {
      // replace path = "File.swift" for this fileRef with nested path
      const ref = fileRefs[rel]
      out = out.replace(
        `${ref} /* ${base} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${JSON.stringify(base)}; sourceTree = "<group>"; };`,
        `${ref} /* ${base} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${JSON.stringify(sub)}; sourceTree = "<group>"; };`,
      )
    }
  }
  // Assets path relative to Agim
  out = out.replace(
    `${assetsRef} /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };`,
    `${assetsRef} /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Resources/Assets.xcassets; sourceTree = "<group>"; };`,
  )
  return out
}

const outDir = path.join(root, 'Agim.xcodeproj')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'project.pbxproj'), rewriteWithNestedPaths())
console.log(`Wrote ${outDir}/project.pbxproj (${swiftSources.length} sources, ${tests.length} tests)`)
