import * as sauce from '../../shared/sauce/index.mjs';
import * as common from './common.mjs';
import * as map from './map.mjs';
import * as elevation from './elevation.mjs';

const doc = document.documentElement;
const L = sauce.locale;
let imperial = !!common.storage.get('/imperialUnits');
L.setImperial(imperial);

common.settingsStore.setDefault({
    profileOverlay: true,
    mapStyle: 'default',
    tiltShift: false,
    tiltShiftAngle: 10,
    sparkle: false,
    solidBackground: false,
    transparency: 0,
    backgroundColor: '#00ff00',
});

const settings = common.settingsStore.get();

let initDone;
let watchingId;
let zwiftMap;
let elProfile;


const fields = [{
    id: 'grade',
    value: x => H.percent(x && x.grade),
    key: 'Grade',
    unit: '%',
}, {
    id: 'altitude',
    value: x => H.elevation(x && x.altitude, {suffix: true}),
    key: 'Altitude',
}];


function setBackground() {
    const {solidBackground, backgroundColor} = common.settingsStore.get();
    doc.classList.toggle('solid-background', !!solidBackground);
    if (solidBackground) {
        doc.style.setProperty('--background-color', backgroundColor);
    } else {
        doc.style.removeProperty('--background-color');
    }
}


function createZwiftMap({worldList}) {
    const zwiftMap = new map.SauceZwiftMap({
        el: document.querySelector('.map'),
        worldList,
        zoom: settings.zoom,
    });
    let settingsSaveTimeout;
    zwiftMap.addEventListener('zoom', ev => {
        clearTimeout(settingsSaveTimeout);
        settings.zoom = ev.zoom;
        settingsSaveTimeout = setTimeout(() => common.settingsStore.set(null, settings), 100);
    });
    zwiftMap.setStyle(settings.mapStyle);
    zwiftMap.setOpacity(1 - 1 / (100 / (settings.transparency || 0)));
    zwiftMap.setTiltShift(settings.tiltShift);
    zwiftMap.setTiltShiftAngle(settings.tiltShiftAngle || 10);
    zwiftMap.setSparkle(settings.sparkle);
    return zwiftMap;
}


function createElevationProfile({worldList}) {
    return new elevation.SauceElevationProfile({
        el: document.querySelector('.elevation-profile'),
        worldList,
    });
}


function setWatching(id) {
    console.info("Now watching:", id);
    watchingId = id;
    zwiftMap.setAthleteId(id);
    if (elProfile) {
        elProfile.setAthleteId(id);
    }
}


async function initSelfAthlete() {
    const ad = await common.rpc.getAthleteData('self');
    if (!ad) {
        return false;
    }
    zwiftMap.setAthleteId(ad.athleteId);
    if (elProfile) {
        elProfile.setAthleteId(ad.athleteId);
    }
    if (!ad.watching) {
        const watching = await common.rpc.getAthleteData('watching');
        setWatching(watching.athleteId);
    } else {
        setWatching(ad.athleteId);
    }
    return true;
}


export async function main() {
    common.initInteractionListeners();
    const fieldRenderer = new common.Renderer(document.querySelector('#content'), {
        fps: null,
        //locked: settings.lockedFields,
    });
    renderer.addRotatingFields({
        el: groupEl,
        mapping,
        fields: groupSpec.fields,

    });

    const worldList = await common.getWorldList();
    const zwiftMap = createZwiftMap({worldList});
    const elProfile = settings.profileOverlay && createElevationProfile({worldList});
    const urlQuery = new URLSearchParams(location.search);
    if (urlQuery.has('testing')) {
        zwiftMap.setCourse(+urlQuery.get('testing') || 6);
        return;
    }
    common.subscribe('watching-athlete-change', async athleteId => {
        if (!initDone) {
            initDone = await initSelfAthlete();
        }
        setWatching(athleteId);
    });
    common.subscribe('states', async states => {
        if (!initDone) {
            initDone = await initSelfAthlete({zwiftMap, elProfile});
        }
        zwiftMap.renderAthleteStates(states);
        if (elProfile) {
            elProfile.renderAthleteStates(states);
        }
        const watching = states.find(x => x.athleteId === watchingId);
        if (watching) {
            document.documentElement.
        }
    });
    initDone = await initSelfAthlete({zwiftMap, elProfile});
    if (!initDone) {
        console.info("User not active, starting demo mode...");
        zwiftMap.setCourse(6);
        if (elProfile) {
            elProfile.setCourse(6);
        }
        let i = 0;
        const updateHeading = () => {
            if (initDone) {
                zwiftMap.setHeadingOffset(0);
            } else {
                zwiftMap.setHeadingOffset(i += 5);
                setTimeout(updateHeading, 1000);
            }
        };
        updateHeading();
    }
    common.settingsStore.addEventListener('changed', async ev => {
        const changed = ev.data.changed;
        if (changed.has('solidBackground') || changed.has('backgroundColor')) {
            setBackground();
        } else if (changed.has('transparency')) {
            zwiftMap.setOpacity(1 - 1 / (100 / changed.get('transparency')));
        } else if (changed.has('mapStyle')) {
            zwiftMap.setStyle(changed.get('mapStyle'));
        } else if (changed.has('tiltShift')) {
            zwiftMap.setTiltShift(changed.get('tiltShift'));
        } else if (changed.has('tiltShiftAngle')) {
            zwiftMap.setTiltShiftAngle(changed.get('tiltShiftAngle'));
        } else if (changed.has('sparkle')) {
            zwiftMap.setSparkle(changed.get('sparkle'));
        } else if (changed.has('profileOverlay')) {
            location.reload();
        }
    });
}


export async function settingsMain() {
    common.initInteractionListeners();
    (await common.initSettingsForm('form'))();
}


setBackground();
