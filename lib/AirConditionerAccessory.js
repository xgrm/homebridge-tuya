const BaseAccessory = require('./BaseAccessory');

class AirConditionerAccessory extends BaseAccessory {
    static getCategory(Categories) {
        return Categories.AIR_CONDITIONER;
    }

    constructor(...props) {
        super(...props);

        this.cmdCool = 'COOL';
        if (this.device.context.cmdCool) {
            if (/^c[a-z]+$/i.test(this.device.context.cmdCool)) this.cmdCool = ('' + this.device.context.cmdCool).trim();
            else throw new Error('The cmdCool doesn\'t appear to be valid: ' + this.device.context.cmdCool);
        }

        this.cmdHeat = 'HEAT';
        if (this.device.context.cmdHeat) {
            if (/^h[a-z]+$/i.test(this.device.context.cmdHeat)) this.cmdHeat = ('' + this.device.context.cmdHeat).trim();
            else throw new Error('The cmdHeat doesn\'t appear to be valid: ' + this.device.context.cmdHeat);
        }

        this.cmdAuto = 'AUTO';
        if (this.device.context.cmdAuto) {
            if (/^a[a-z]+$/i.test(this.device.context.cmdAuto)) this.cmdAuto = ('' + this.device.context.cmdAuto).trim();
            else throw new Error('The cmdAuto doesn\'t appear to be valid: ' + this.device.context.cmdAuto);
        }

        // Disabling auto mode because I have not found a Tuya device config that has a temperature range for AUTO
        this.device.context.noAuto = true;
        // An explicitly configured cmdAuto (e.g. "auto" = Feel) lets HomeKit's Auto select it
        this._hasCmdAuto = !!this.device.context.cmdAuto;

        // Optional explicit fan values ordered slowest -> fastest (e.g. ["3","2","1","4"] = Low/Med/High/Auto)
        const fanSpeedValues = this.device.context.fanSpeedValues;
        this._fanSpeedValues = (Array.isArray(fanSpeedValues) ? fanSpeedValues : (typeof fanSpeedValues === 'string' ? fanSpeedValues.split(',') : []))
            .map(v => typeof v === 'string' ? v.trim() : v).filter(v => v !== '' && v !== null && v !== undefined);
        if (!this._fanSpeedValues.length) this._fanSpeedValues = null;

        if (!this.device.context.noRotationSpeed) {
            const fanSpeedSteps = (this.device.context.fanSpeedSteps && isFinite(this.device.context.fanSpeedSteps) && this.device.context.fanSpeedSteps > 0 && this.device.context.fanSpeedSteps < 100) ? this.device.context.fanSpeedSteps : 100;
            this._rotationSteps = [0];
            this._rotationStops = {0: 0};
            for (let i = 0; i++ < 100;) {
                const _rotationStep = Math.floor(fanSpeedSteps * (i - 1) / 100) + 1;
                this._rotationSteps.push(_rotationStep);
                this._rotationStops[_rotationStep] = i;
            }
        }
    }

    _registerPlatformAccessory() {
        const {Service} = this.hap;

        this.accessory.addService(Service.HeaterCooler, this.device.context.name);

        super._registerPlatformAccessory();
    }

    _registerCharacteristics(dps) {
        const {Service, Characteristic} = this.hap;
        const service = this.accessory.getService(Service.HeaterCooler);
        this._checkServiceName(service, this.device.context.name);
        
        this.dpActive = this._getCustomDP(this.device.context.dpActive) || '1';
        this.dpThreshold = this._getCustomDP(this.device.context.dpThreshold) || '2';
        this.dpCurrentTemperature = this._getCustomDP(this.device.context.dpCurrentTemperature) || '3';
        this.dpMode = this._getCustomDP(this.device.context.dpMode) || '4';
        this.dpRotationSpeed = this._getCustomDP(this.device.context.dpRotationSpeed) || '5';
        this.dpChildLock = this._getCustomDP(this.device.context.dpChildLock) || '6';
        this.dpTempUnits = this._getCustomDP(this.device.context.dpTempUnits) || '19';
        this.dpSwingMode = this._getCustomDP(this.device.context.dpSwingMode) || '104';
        
        const characteristicActive = service.getCharacteristic(Characteristic.Active)
            .updateValue(this._getActive(dps[this.dpActive]))
            .on('get', this.getActive.bind(this))
            .on('set', this.setActive.bind(this));

        const characteristicCurrentHeaterCoolerState = service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
            .updateValue(this._getCurrentHeaterCoolerState(dps))
            .on('get', this.getCurrentHeaterCoolerState.bind(this));

        // HomeKit only defines Auto (0), Heat (1) and Cool (2); the Home app hides the mode picker for anything
        // else, so modes other than Cool/Heat (Feel/Dry/Fan) are shown as Auto.
        const _validTargetHeaterCoolerStateValues = [Characteristic.TargetHeaterCoolerState.AUTO];
        if (!this.device.context.noCool) _validTargetHeaterCoolerStateValues.unshift(Characteristic.TargetHeaterCoolerState.COOL);
        if (!this.device.context.noHeat) _validTargetHeaterCoolerStateValues.unshift(Characteristic.TargetHeaterCoolerState.HEAT);

        const characteristicTargetHeaterCoolerState = service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
            .setProps({
                maxValue: 2,
                validValues: _validTargetHeaterCoolerStateValues
            })
            .updateValue(this._getTargetHeaterCoolerState(dps[this.dpMode]))
            .on('get', this.getTargetHeaterCoolerState.bind(this))
            .on('set', this.setTargetHeaterCoolerState.bind(this));

        const characteristicCurrentTemperature = service.getCharacteristic(Characteristic.CurrentTemperature)
            .updateValue(dps[this.dpCurrentTemperature])
            .on('get', this.getState.bind(this, this.dpCurrentTemperature));

        let characteristicSwingMode;
        if (!this.device.context.noSwing) {
            characteristicSwingMode = service.getCharacteristic(Characteristic.SwingMode)
                .updateValue(this._getSwingMode(dps[this.dpSwingMode]))
                .on('get', this.getSwingMode.bind(this))
                .on('set', this.setSwingMode.bind(this));
        } else this._removeCharacteristic(service, Characteristic.SwingMode);

        let characteristicLockPhysicalControls;
        if (!this.device.context.noChildLock) {
            characteristicLockPhysicalControls = service.getCharacteristic(Characteristic.LockPhysicalControls)
                .updateValue(this._getLockPhysicalControls(dps[this.dpChildLock]))
                .on('get', this.getLockPhysicalControls.bind(this))
                .on('set', this.setLockPhysicalControls.bind(this));
        } else this._removeCharacteristic(service, Characteristic.LockPhysicalControls);

        let characteristicCoolingThresholdTemperature;
        if (!this.device.context.noCool) {
            characteristicCoolingThresholdTemperature = service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
                .setProps({
                    minValue: this.device.context.minTemperature || 10,
                    maxValue: this.device.context.maxTemperature || 35,
                    minStep: this.device.context.minTemperatureSteps || 1
                })
                .updateValue(dps[this.dpThreshold])
                .on('get', this.getState.bind(this, this.dpThreshold))
                .on('set', this.setTargetThresholdTemperature.bind(this, 'cool'));
        } else this._removeCharacteristic(service, Characteristic.CoolingThresholdTemperature);

        let characteristicHeatingThresholdTemperature;
        if (!this.device.context.noHeat) {
            characteristicHeatingThresholdTemperature = service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
                .setProps({
                    minValue: this.device.context.minTemperature || 10,
                    maxValue: this.device.context.maxTemperature || 35,
                    minStep: this.device.context.minTemperatureSteps || 1
                })
                .updateValue(dps[this.dpThreshold])
                .on('get', this.getState.bind(this, this.dpThreshold))
                .on('set', this.setTargetThresholdTemperature.bind(this, 'heat'));
        } else this._removeCharacteristic(service, Characteristic.HeatingThresholdTemperature);

        const characteristicTemperatureDisplayUnits = service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .updateValue(this._getTemperatureDisplayUnits(dps[this.dpTempUnits]))
            .on('get', this.getTemperatureDisplayUnits.bind(this))
            .on('set', this.setTemperatureDisplayUnits.bind(this));

        let characteristicRotationSpeed;
        if (!this.device.context.noRotationSpeed) {
            characteristicRotationSpeed = service.getCharacteristic(Characteristic.RotationSpeed);
            if (this._fanSpeedValues) characteristicRotationSpeed.setProps({minStep: 100 / this._fanSpeedValues.length});
            characteristicRotationSpeed
                .updateValue(this._getRotationSpeed(dps))
                .on('get', this.getRotationSpeed.bind(this))
                .on('set', this.setRotationSpeed.bind(this));
        } else this._removeCharacteristic(service, Characteristic.RotationSpeed);

        this.characteristicCoolingThresholdTemperature = characteristicCoolingThresholdTemperature;
        this.characteristicRotationSpeed = characteristicRotationSpeed;
        this.characteristicHeatingThresholdTemperature = characteristicHeatingThresholdTemperature;

        this.device.on('change', (changes, state) => {
            if (changes.hasOwnProperty(this.dpActive)) {
                const newActive = this._getActive(changes[this.dpActive]);
                if (characteristicActive.value !== newActive) {
                    characteristicActive.updateValue(newActive);

                    if (!changes.hasOwnProperty(this.dpMode)) {
                        characteristicCurrentHeaterCoolerState.updateValue(this._getCurrentHeaterCoolerState(state));
                    }

                    if (characteristicRotationSpeed && !changes.hasOwnProperty(this.dpRotationSpeed)) {
                        characteristicRotationSpeed.updateValue(this._getRotationSpeed(state));
                    }
                }
            }

            if (characteristicLockPhysicalControls && changes.hasOwnProperty(this.dpChildLock)) {
                const newLockPhysicalControls = this._getLockPhysicalControls(changes[this.dpChildLock]);
                if (characteristicLockPhysicalControls.value !== newLockPhysicalControls) {
                    characteristicLockPhysicalControls.updateValue(newLockPhysicalControls);
                }
            }

            if (changes.hasOwnProperty(this.dpThreshold)) {
                if (!this.device.context.noCool && characteristicCoolingThresholdTemperature && characteristicCoolingThresholdTemperature.value !== changes[this.dpThreshold])
                    characteristicCoolingThresholdTemperature.updateValue(changes[this.dpThreshold]);
                if (!this.device.context.noHeat && characteristicHeatingThresholdTemperature && characteristicHeatingThresholdTemperature.value !== changes[this.dpThreshold])
                    characteristicHeatingThresholdTemperature.updateValue(changes[this.dpThreshold]);
            }

            if (changes.hasOwnProperty(this.dpCurrentTemperature) && characteristicCurrentTemperature.value !== changes[this.dpCurrentTemperature]) characteristicCurrentTemperature.updateValue(changes[this.dpCurrentTemperature]);

            if (changes.hasOwnProperty(this.dpMode)) {
                const newTargetHeaterCoolerState = this._getTargetHeaterCoolerState(changes[this.dpMode]);
                const newCurrentHeaterCoolerState = this._getCurrentHeaterCoolerState(state);
                if (characteristicTargetHeaterCoolerState.value !== newTargetHeaterCoolerState) characteristicTargetHeaterCoolerState.updateValue(newTargetHeaterCoolerState);
                if (characteristicCurrentHeaterCoolerState.value !== newCurrentHeaterCoolerState) characteristicCurrentHeaterCoolerState.updateValue(newCurrentHeaterCoolerState);
            }

            if (characteristicSwingMode && changes.hasOwnProperty(this.dpSwingMode)) {
                const newSwingMode = this._getSwingMode(changes[this.dpSwingMode]);
                if (characteristicSwingMode.value !== newSwingMode) characteristicSwingMode.updateValue(newSwingMode);
            }

            if (changes.hasOwnProperty(this.dpTempUnits)) {
                const newTemperatureDisplayUnits = this._getTemperatureDisplayUnits(changes[this.dpTempUnits]);
                if (characteristicTemperatureDisplayUnits.value !== newTemperatureDisplayUnits) characteristicTemperatureDisplayUnits.updateValue(newTemperatureDisplayUnits);
            }

            if (characteristicRotationSpeed && changes.hasOwnProperty(this.dpRotationSpeed)) {
                const newRotationSpeed = this._getRotationSpeed(state);
                if (characteristicRotationSpeed.value !== newRotationSpeed) characteristicRotationSpeed.updateValue(newRotationSpeed);

                if (!changes.hasOwnProperty(this.dpMode)) {
                    characteristicCurrentHeaterCoolerState.updateValue(this._getCurrentHeaterCoolerState(state));
                }
            }
        });

        this._registerExtraSwitches();
    }

    getActive(callback) {
        this.getState(this.dpActive, (err, dp) => {
            if (err) return callback(err);

            callback(null, this._getActive(dp));
        });
    }

    _getActive(dp) {
        const {Characteristic} = this.hap;

        return dp ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
    }

    setActive(value, callback) {
        const {Characteristic} = this.hap;

        switch (value) {
            case Characteristic.Active.ACTIVE:
                return this.setState(this.dpActive, true, callback);

            case Characteristic.Active.INACTIVE:
                return this.setState(this.dpActive, false, callback);
        }

        callback();
    }

    getLockPhysicalControls(callback) {
        this.getState(this.dpChildLock, (err, dp) => {
            if (err) return callback(err);

            callback(null, this._getLockPhysicalControls(dp));
        });
    }

    _getLockPhysicalControls(dp) {
        const {Characteristic} = this.hap;

        return dp ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
    }

    setLockPhysicalControls(value, callback) {
        const {Characteristic} = this.hap;

        switch (value) {
            case Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED:
                return this.setState(this.dpChildLock, true, callback);

            case Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED:
                return this.setState(this.dpChildLock, false, callback);
        }

        callback();
    }

    getCurrentHeaterCoolerState(callback) {
        this.getState([this.dpActive, this.dpMode], (err, dps) => {
            if (err) return callback(err);

            callback(null, this._getCurrentHeaterCoolerState(dps));
        });
    }

    _getCurrentHeaterCoolerState(dps) {
        const {Characteristic} = this.hap;
        if (!dps[this.dpActive]) return Characteristic.CurrentHeaterCoolerState.INACTIVE;

        switch (dps[this.dpMode]) {
            case this.cmdCool:
                return Characteristic.CurrentHeaterCoolerState.COOLING;

            case this.cmdHeat:
                return Characteristic.CurrentHeaterCoolerState.HEATING;

            default:
                return Characteristic.CurrentHeaterCoolerState.IDLE;
        }
    }

    getTargetHeaterCoolerState(callback) {
        this.getState(this.dpMode, (err, dp) => {
            if (err) return callback(err);

            callback(null, this._getTargetHeaterCoolerState(dp));
        });
    }

    _getTargetHeaterCoolerState(dp) {
        const {Characteristic} = this.hap;

        switch (dp) {
            case this.cmdCool:
                if (this.device.context.noCool) return Characteristic.TargetHeaterCoolerState.AUTO;
                return Characteristic.TargetHeaterCoolerState.COOL;

            case this.cmdHeat:
                if (this.device.context.noHeat) return Characteristic.TargetHeaterCoolerState.AUTO;
                return Characteristic.TargetHeaterCoolerState.HEAT;

            case this.cmdAuto:
                return Characteristic.TargetHeaterCoolerState.AUTO;

            default:
                return Characteristic.TargetHeaterCoolerState.AUTO;
        }
    }

    setTargetHeaterCoolerState(value, callback) {
        // Cool/Heat/Auto replace any Feel/Dry/Fan mode: clear those switches once the request went out
        const done = err => {
            if (!err && this._groupOff) this._groupOff('mode');
            callback(err);
        };
        const {Characteristic} = this.hap;

        switch (value) {
            case Characteristic.TargetHeaterCoolerState.COOL:
                if (this.device.context.noCool) return callback();
                this._requestedMode = this.cmdCool;
                return this.setState(this.dpMode, this.cmdCool, done);

            case Characteristic.TargetHeaterCoolerState.HEAT:
                if (this.device.context.noHeat) return callback();
                this._requestedMode = this.cmdHeat;
                return this.setState(this.dpMode, this.cmdHeat, done);

            case Characteristic.TargetHeaterCoolerState.AUTO: {
                if (!this._hasCmdAuto) return callback();
                // Auto is also how Feel/Dry/Fan are shown: only switch when coming from Cool/Heat, and not while a
                // mode switch has just requested another mode (a scene saved in Dry also writes Auto)
                const coolOrHeat = mode => mode === this.cmdCool || mode === this.cmdHeat;
                if (!coolOrHeat(this.device.state[this.dpMode])) return callback();
                if (this._requestedMode !== undefined && !coolOrHeat(this._requestedMode)) return callback();
                this._requestedMode = this.cmdAuto;
                return this.setState(this.dpMode, this.cmdAuto, done);
            }
        }

        callback();
    }

    getSwingMode(callback) {
        this.getState(this.dpSwingMode, (err, dp) => {
            if (err) return callback(err);

            callback(null, this._getSwingMode(dp));
        });
    }

    _getSwingMode(dp) {
        const {Characteristic} = this.hap;

        return dp ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED;
    }

    setSwingMode(value, callback) {
        if (this.device.context.noSwing) return callback();

        const {Characteristic} = this.hap;

        switch (value) {
            case Characteristic.SwingMode.SWING_ENABLED:
                return this.setState(this.dpSwingMode, true, callback);

            case Characteristic.SwingMode.SWING_DISABLED:
                return this.setState(this.dpSwingMode, false, callback);
        }

        callback();
    }

    setTargetThresholdTemperature(mode, value, callback) {
        this.setState(this.dpThreshold, value, err => {
            if (err) return callback(err);

            if (mode === 'cool' && !this.device.context.noHeat && this.characteristicHeatingThresholdTemperature) {
                this.characteristicHeatingThresholdTemperature.updateValue(value);
            } else if (mode === 'heat' && !this.device.context.noCool && this.characteristicCoolingThresholdTemperature) {
                this.characteristicCoolingThresholdTemperature.updateValue(value);
            }

            callback();
        });
    }
    getTemperatureDisplayUnits(callback) {
        this.getState(this.dpTempUnits, (err, dp) => {
            if (err) return callback(err);

            callback(null, this._getTemperatureDisplayUnits(dp));
        });
    }

    _getTemperatureDisplayUnits(dp) {
        const {Characteristic} = this.hap;

        return dp === 'F' ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : Characteristic.TemperatureDisplayUnits.CELSIUS;
    }

    setTemperatureDisplayUnits(value, callback) {
        const {Characteristic} = this.hap;

        this.setState(this.dpTempUnits, value === Characteristic.TemperatureDisplayUnits.FAHRENHEIT ? 'F' : 'C', callback);
    }

    getRotationSpeed(callback) {
        this.getState([this.dpActive, this.dpRotationSpeed], (err, dps) => {
            if (err) return callback(err);

            callback(null, this._getRotationSpeed(dps));
        });
    }

    _getRotationSpeed(dps) {
        if (!dps[this.dpActive]) return 0;
        if (this._fanSpeedValues) {
            const n = this._fanSpeedValues.length;
            const index = this._fanSpeedValues.findIndex(v => String(v) === String(dps[this.dpRotationSpeed]));
            if (index >= 0) this._fanSpeedPercent = Math.round((index + 1) * 100 / n);
            else if (dps[this.dpRotationSpeed] !== undefined && this._fanSpeedUnknown !== dps[this.dpRotationSpeed]) {
                this._fanSpeedUnknown = dps[this.dpRotationSpeed];
                this.log.warn('%s: fan speed value %j is not in fanSpeedValues %j', this.device.context.name, dps[this.dpRotationSpeed], this._fanSpeedValues);
            }
            return this._fanSpeedPercent || Math.round(100 / n);
        }

        if (this._hkRotationSpeed) {
            const currntRotationSpeed = this.convertRotationSpeedFromHomeKitToTuya(this._hkRotationSpeed);

            return currntRotationSpeed === dps[this.dpRotationSpeed] ? this._hkRotationSpeed : this.convertRotationSpeedFromTuyaToHomeKit(dps[this.dpRotationSpeed]);
        }

        return this._hkRotationSpeed = this.convertRotationSpeedFromTuyaToHomeKit(dps[this.dpRotationSpeed]);
    }

    // Optional "Fan Speed" tile: the Home app doesn't show RotationSpeed on the AC (HeaterCooler) tile.
    // Returns true when the accessory's services changed.
    _registerFanSpeedTile() {
        const {Service, Characteristic} = this.hap;
        let service = this.accessory.getServiceById(Service.Fanv2, 'fanSpeed');
        if (!this._coerceBoolean(this.device.context.exposeFanSpeed, false) || this.device.context.noRotationSpeed) {
            if (!service) return false;
            this.accessory.removeService(service);
            return true;
        }

        const name = 'Fan Speed';
        let changed = false;
        if (!service) {
            service = this.accessory.addService(Service.Fanv2, name, 'fanSpeed');
            changed = true;
        }
        this._checkServiceName(service, name);
        this._setDefaultConfiguredName(service, name);

        const active = service.getCharacteristic(Characteristic.Active)
            .updateValue(this._getActive(this.device.state[this.dpActive]))
            .on('get', this.getActive.bind(this))
            .on('set', this.setActive.bind(this));
        const speed = service.getCharacteristic(Characteristic.RotationSpeed);
        if (this._fanSpeedValues) speed.setProps({minStep: 100 / this._fanSpeedValues.length});
        speed.updateValue(this._getRotationSpeed(this.device.state))
            .on('get', this.getRotationSpeed.bind(this))
            .on('set', this.setRotationSpeed.bind(this));
        this.characteristicFanTileSpeed = speed;

        this.device.on('change', (changes, state) => {
            if (changes.hasOwnProperty(this.dpActive)) active.updateValue(this._getActive(state[this.dpActive]));
            if ([this.dpActive, this.dpRotationSpeed, this.dpMode].some(dp => changes.hasOwnProperty(dp))) speed.updateValue(this._getRotationSpeed(state));
        });
        return changed;
    }

    // In Dry mode the AC runs the fan on Auto and ignores speed changes
    _isFanLocked() {
        const cmdDry = this.device.context.cmdDry ? ('' + this.device.context.cmdDry).trim() : 'wet';
        return !!this.device.state[this.dpActive] && this.device.state[this.dpMode] === cmdDry;
    }

    _refreshRotationSpeed() {
        const value = this._getRotationSpeed(this.device.state);
        [this.characteristicRotationSpeed, this.characteristicFanTileSpeed].forEach(c => c && c.updateValue(value));
    }

    setRotationSpeed(value, callback) {
        if (value !== 0 && this._isFanLocked()) {
            callback();
            // HomeKit already moved the slider; put it back to what the AC really does
            setImmediate(() => this._refreshRotationSpeed());
            return;
        }
        const {Characteristic} = this.hap;

        if (value === 0) {
            this.setActive(Characteristic.Active.INACTIVE, callback);
        } else if (this._fanSpeedValues) {
            const n = this._fanSpeedValues.length;
            // Nearest step: tolerant of HAP snapping to minStep (e.g. 66.666...% for 3 values)
            const wanted = this._fanSpeedValues[Math.min(n, Math.max(1, Math.round(value * n / 100))) - 1];
            const current = this.device.state[this.dpRotationSpeed];
            // Match the type the device reports (Tuya enums are strings, some fans use numbers)
            const deviceValue = typeof current === 'number' ? Number(wanted) : (typeof current === 'string' ? String(wanted) : wanted);
            this.setMultiState({[this.dpActive]: true, [this.dpRotationSpeed]: deviceValue}, callback);
        } else {
            this._hkRotationSpeed = value;
            this.setMultiState({[this.dpActive]: true, [this.dpRotationSpeed]: this.convertRotationSpeedFromHomeKitToTuya(value)}, callback);
        }
    }

    convertRotationSpeedFromTuyaToHomeKit(value) {
        return this._rotationStops[parseInt(value)];
    }

    convertRotationSpeedFromHomeKitToTuya(value) {
        return this.device.context.fanSpeedSteps ? '' + this._rotationSteps[value] : this._rotationSteps[value];
    }

    // Optional Switch services for AC functions HomeKit's HeaterCooler has no place for.
    // Each is a settings checkbox; switches can also be used in Apple Home automations.
    _registerExtraSwitches() {
        const {Service, Characteristic} = this.hap;
        const context = this.device.context;

        const booleanFunction = (dpKey, defaultDp, group) => {
            const dp = this._getCustomDP(context[dpKey]) || defaultDp;
            return {
                group,
                dps: [dp],
                isOn: state => !!state[dp],
                set: (value, callback) => this.setState(dp, !!value, callback)
            };
        };
        const modeFunction = (cmdKey, defaultMode) => {
            const mode = context[cmdKey] ? ('' + context[cmdKey]).trim() : defaultMode;
            return {
                group: 'mode',
                dps: [this.dpActive, this.dpMode],
                isOn: state => !!state[this.dpActive] && state[this.dpMode] === mode,
                set: (value, callback) => {
                    if (value) {
                        this._requestedMode = mode;
                        return this.setMultiState({[this.dpActive]: true, [this.dpMode]: mode}, callback);
                    }
                    // Turning the mode off while the AC runs in it switches the AC off - unless another mode was
                    // just requested (e.g. a scene setting Cool and "Dry off" before the device reports the change)
                    const otherModePending = this._requestedMode !== undefined && this._requestedMode !== mode;
                    if (this.device.state[this.dpActive] && this.device.state[this.dpMode] === mode && !otherModePending) return this.setState(this.dpActive, false, callback);
                    callback();
                }
            };
        };

        const definitions = [
            // Sleep / Turbo / ECO: the AC allows only one at a time ('function' group)
            ['exposeEco', 'eco', 'ECO', booleanFunction('dpEco', '8', 'function')],
            ['exposeSleep', 'sleep', 'Sleep', booleanFunction('dpSleep', '101', 'function')],
            ['exposeTurbo', 'turbo', 'Turbo', booleanFunction('dpTurbo', '102', 'function')],
            ['exposeSwingHorizontal', 'swingHorizontal', 'Swing Left-Right', booleanFunction('dpSwingHorizontal', '105')],
            // Feel / Dry / Fan: one AC mode at a time ('mode' group, together with Cool/Heat on the AC tile)
            ['exposeFeelMode', 'modeFeel', 'Feel', modeFunction('cmdFeel', 'auto')],
            ['exposeDryMode', 'modeDry', 'Dry', modeFunction('cmdDry', 'wet')],
            ['exposeFanMode', 'modeFan', 'Fan', modeFunction('cmdFan', 'wind')]
        ];

        const active = [];
        let changed = false;
        definitions.forEach(([option, subtype, label, fn]) => {
            let service = this.accessory.getServiceById(Service.Switch, subtype);
            if (!this._coerceBoolean(context[option], false)) {
                if (service) {
                    this.accessory.removeService(service);
                    changed = true;
                }
                return;
            }

            // Function name only: the Home app has little room and shows the switches on the AC's own page
            const name = label;
            if (!service) {
                service = this.accessory.addService(Service.Switch, name, subtype);
                changed = true;
            }
            this._checkServiceName(service, name);
            this._setDefaultConfiguredName(service, name, [context.name + ' ' + label]);

            const characteristic = service.getCharacteristic(Characteristic.On)
                .updateValue(fn.isOn(this.device.state))
                .on('get', next => this.getState(fn.dps, (err, state) => next(err, err ? undefined : fn.isOn(state))))
                .on('set', (value, callback) => fn.set(value, err => {
                    // The AC enforces one-of-a-group itself; show it in Home without waiting for the report
                    if (!err && value && fn.group) this._groupOff(fn.group, characteristic);
                    callback(err);
                }));
            active.push({characteristic, fn});
        });

        this._groupOff = (group, except) => {
            const members = active.filter(({fn}) => fn.group === group);
            members.filter(({characteristic}) => characteristic !== except).forEach(({characteristic}) => characteristic.updateValue(false));
            // If the AC ignored the command it never reports a change; fall back to what it last reported
            clearTimeout(this._groupResync && this._groupResync[group]);
            this._groupResync = this._groupResync || {};
            this._groupResync[group] = setTimeout(() => {
                members.forEach(({characteristic, fn}) => characteristic.updateValue(fn.isOn(this.device.state)));
            }, 3000);
        };

        if (this._registerFanSpeedTile()) changed = true;

        if (changed) this.platform.api.updatePlatformAccessories([this.accessory]);

        if (active.length || this.characteristicFanTileSpeed) {
            // Keep the AC tile the main control when switches are added
            this.accessory.getService(Service.HeaterCooler).setPrimaryService(true);
        }

        this.device.on('change', changes => {
            if (changes.hasOwnProperty(this.dpMode)) this._requestedMode = undefined;
        });

        if (active.length) this.device.on('change', (changes, state) => {
            active.forEach(({characteristic, fn}) => {
                if (fn.dps.some(dp => changes.hasOwnProperty(dp))) characteristic.updateValue(fn.isOn(state));
            });
        });
    }
}

module.exports = AirConditionerAccessory;
