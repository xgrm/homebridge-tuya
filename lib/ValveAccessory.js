const BaseAccessory = require('./BaseAccessory');

class ValveAccessory extends BaseAccessory {
    static getCategory(Categories) {
        return Categories.FAUCET;
    }

    constructor(...props) {
        super(...props);
    }

    _registerPlatformAccessory() {
        const {Service} = this.hap;

        this.accessory.addService(Service.Valve, this.device.context.name);

        super._registerPlatformAccessory();
    }

    _registerCharacteristics(dps) {
        const {Service, Characteristic} = this.hap;
        const service = this.accessory.getService(Service.Valve);
        this._checkServiceName(service, this.device.context.name);
        this.setDuration = this.device.context.defaultDuration || 600;
        this.noTimer = this.device.context.noTimer;
        this.lastActivationTime = null
        this.timer = null;
        // Optional DP holding the device's own countdown (e.g. a water heater's auto-off timer)
        this.dpRemainingDuration = this._getCustomDP(this.device.context.dpRemainingDuration);
        this.remainingDurationScale = String(this.device.context.remainingDurationUnit || 'minutes').toLowerCase() === 'seconds' ? 1 : 60;
        // HomeKit caps SetDuration/RemainingDuration at 3600s by default; allow longer configured durations
        this.maxDuration = Math.max(3600, this.setDuration);
        // Write HomeKit's duration to the device countdown DP instead of running a plugin timer
        const wantSync = this._coerceBoolean(this.device.context.syncDurationToDevice, false);
        this.syncDuration = !!this.dpRemainingDuration && wantSync;
        if (wantSync && !this.dpRemainingDuration) this.log.warn('%s: syncDurationToDevice needs dpRemainingDuration; ignoring it.', this.device.context.name);
        this.pendingDurationUntil = null;

        switch (this.device.context.valveType) {
            case 'IRRIGATION':
                service.getCharacteristic(Characteristic.ValveType).updateValue(1);
                break;
            case 'SHOWER_HEAD':
                service.getCharacteristic(Characteristic.ValveType).updateValue(2);
                break;
            case 'WATER_FAUCET':
                service.getCharacteristic(Characteristic.ValveType).updateValue(3);
                break;
            default:
                service.getCharacteristic(Characteristic.ValveType).updateValue(0);
                break;
        }

        this.dpPower = this._getCustomDP(this.device.context.dpPower) || '1';
            
        const characteristicActive = service.getCharacteristic(Characteristic.Active)
            .updateValue(dps[this.dpPower])
            .on('get', this.getState.bind(this, this.dpPower))
            // HomeKit Active is 0/1; Tuya switch DPs are booleans (devices may ignore a numeric 0)
            .on('set', (value, callback) => {
                // Device resets its countdown when switched on; re-apply HomeKit's duration once it reports it
                const arm = this.syncDuration && value && !characteristicActive.value;
                this.setState(this.dpPower, !!value, err => {
                    if (arm && !err) this.pendingDurationUntil = Date.now() + 15000;
                    callback(err);
                });
            });

        const characteristicInUse = service.getCharacteristic(Characteristic.InUse)
            .on('get', (next) => {
                next(null, characteristicActive.value)
            })


        if (this.syncDuration) {
            // The device owns the countdown: HomeKit's duration is written to it, no plugin timer
            service.getCharacteristic(Characteristic.SetDuration)
                .setProps({maxValue: this.maxDuration})
                .updateValue(this.setDuration)
                .on('get', (next) => next(null, this.setDuration))
                .on('set', (value, callback) => {
                    const accept = () => {
                        this.setDuration = value;
                        this.log.info("Water Valve Time Duration Set to: " + Math.round(value/60) + " Minutes");
                    };
                    if (!characteristicActive.value) {
                        accept();
                        return callback();
                    }
                    this.setState(this.dpRemainingDuration, this._durationToDevice(value), err => {
                        if (!err) accept();
                        callback(err);
                    });
                });

            service.getCharacteristic(Characteristic.RemainingDuration)
                .setProps({maxValue: this.maxDuration})
                .updateValue(this._remainingDuration())
                .on('get', (next) => next(null, this._remainingDuration()));

            characteristicInUse.updateValue(dps[this.dpPower] ? 1 : 0);
        } else if (!this.noTimer) {
            service.getCharacteristic(Characteristic.SetDuration)
                .setProps({maxValue: this.maxDuration})
                .updateValue(this.setDuration)
                .on('get', (next) => {
                    next(null, this.setDuration)
                })
                .on('change', (data)=> {
                    this.log.info("Water Valve Time Duration Set to: " + data.newValue/60 + " Minutes")
                    this.setDuration = data.newValue

                    if(service.getCharacteristic(Characteristic.InUse).value) {
                        this.lastActivationTime = (new Date()).getTime();
                        service.getCharacteristic(Characteristic.RemainingDuration)
                            .updateValue(this._remainingDuration());
                            
                        clearTimeout(this.timer); // clear any existing timer
                        this.timer = setTimeout( ()=> {
                            this.log.info("Water Valve Timer Expired. Shutting OFF Valve");
                            service.getCharacteristic(Characteristic.Active).setValue(0); 
                            service.getCharacteristic(Characteristic.InUse).updateValue(0); 
                            this.lastActivationTime = null;
                        }, (data.newValue *1000));	
                    }
                }); // end .on('change' ...

            service.getCharacteristic(Characteristic.RemainingDuration)
                .setProps({maxValue: this.maxDuration})
                .on('get', (next) => {
                    next(null, this._remainingDuration())
                })

            service.getCharacteristic(Characteristic.InUse)
                .on('change', (data) => {
                        switch(data.newValue) {
                            case 0:
                                this.lastActivationTime = null
                                service.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
                                service.getCharacteristic(Characteristic.Active).updateValue(0);
                                clearTimeout(this.timer); // clear the timer if it was used!
                                this.log.info("Water Valve is OFF!");
                                break;
                            case 1:
                                this.lastActivationTime = (new Date()).getTime();                               
                                service.getCharacteristic(Characteristic.RemainingDuration).updateValue(this._remainingDuration());
                                service.getCharacteristic(Characteristic.Active).updateValue(1);
                                this.log.info("Water Valve Turning ON with Timer Set to: "+  this.setDuration/60 + " Minutes");
                                clearTimeout(this.timer); // clear any existing timer
                                this.timer = setTimeout(()=> {
                                    this.log.info("Water Valve Timer Expired. Shutting OFF Valve");
                                    // use 'setvalue' when the timer ends so it triggers the .on('set'...) event
                                    service.getCharacteristic(Characteristic.Active).setValue(0);
                                    service.getCharacteristic(Characteristic.InUse).updateValue(0); 
                                    this.lastActivationTime = null;
                                }, (this.setDuration *1000));
                                break;
                        }
                    }); // end .on('change' ...
                    
            // If Homebridge crash when valve is on the timer reset
            if (dps[this.dpPower]) {
                this.lastActivationTime = (new Date()).getTime();                               
                service.getCharacteristic(Characteristic.RemainingDuration).updateValue(this._remainingDuration());
                service.getCharacteristic(Characteristic.Active).updateValue(1);
                service.getCharacteristic(Characteristic.InUse).updateValue(1); 
                this.log.info("Water Valve is ON After Restart. Setting Timer to: "+  this.setDuration/60 + " Minutes");	
                clearTimeout(this.timer); // clear any existing timer								
                this.timer = setTimeout(()=> {
                        this.log.info("Water Valve Timer Expired. Shutting OFF Valve");
                        // use 'setvalue' when the timer ends so it triggers the .on('set'...) event
                        service.getCharacteristic(Characteristic.Active).setValue(0); 
                        this.lastActivationTime = null;
                }, (this.setDuration *1000));
            }

        } else if (this.dpRemainingDuration) {
            // No HomeKit run timer, but still show the device's own countdown
            service.getCharacteristic(Characteristic.RemainingDuration)
                .setProps({maxValue: this.maxDuration})
                .updateValue(this._remainingDuration())
                .on('get', (next) => {
                    next(null, this._remainingDuration())
                });
        } // end if(!this.noTimer)


        this.device.on('change', changes => {
            if (changes.hasOwnProperty(this.dpPower) && characteristicActive.value !== changes[this.dpPower]) characteristicActive.updateValue(changes[this.dpPower]);
            if (changes.hasOwnProperty(this.dpPower) && characteristicInUse.value !== changes[this.dpPower]) characteristicInUse.setValue(changes[this.dpPower]);
            
            if (!this.noTimer) {
                if (changes.hasOwnProperty(this.dpPower) && !changes[this.dpPower]){
                    this.lastActivationTime = null;
                    service.getCharacteristic(Characteristic.RemainingDuration).updateValue(0);
                    clearTimeout(this.timer);
                }
            }

            if (this.dpRemainingDuration && (changes.hasOwnProperty(this.dpRemainingDuration) || changes.hasOwnProperty(this.dpPower))) {
                service.getCharacteristic(Characteristic.RemainingDuration).updateValue(this._remainingDuration());
            }

            if (this.syncDuration && this.pendingDurationUntil) {
                const on = !!this.device.state[this.dpPower];
                const reported = Number(this.device.state[this.dpRemainingDuration]);
                if (!on && changes.hasOwnProperty(this.dpPower)) {
                    this.pendingDurationUntil = null;
                } else if (Date.now() > this.pendingDurationUntil) {
                    this.pendingDurationUntil = null;
                } else if (on && reported > 0 && (changes.hasOwnProperty(this.dpRemainingDuration) || changes.hasOwnProperty(this.dpPower))) {
                    // The device has reported its post-power-on countdown; apply HomeKit's current duration once
                    this.pendingDurationUntil = null;
                    const wanted = this._durationToDevice(this.setDuration);
                    if (reported !== wanted) this.setState(this.dpRemainingDuration, wanted);
                }
            }
        });
    }

    // HomeKit seconds -> device countdown units, clamped to 1..maxDuration
    _durationToDevice(seconds) {
        const max = Math.floor(this.maxDuration / this.remainingDurationScale);
        return Math.min(max, Math.max(1, Math.round(seconds / this.remainingDurationScale)));
    }

    // Seconds left: the software timer, capped by the device's own countdown when dpRemainingDuration is set
    _remainingDuration() {
        const software = this.lastActivationTime
            ? Math.max(0, this.setDuration - Math.floor(((new Date()).getTime() - this.lastActivationTime) / 1000))
            : 0;
        if (!this.dpRemainingDuration) return software;
        // Some devices keep their last countdown value after switching off
        if (!this.accessory.getService(this.hap.Service.Valve).getCharacteristic(this.hap.Characteristic.Active).value) return 0;

        const reported = Number(this.device.state[this.dpRemainingDuration]);
        if (!isFinite(reported) || reported <= 0) return software;

        const deviceRemaining = Math.min(Math.round(reported * this.remainingDurationScale), this.maxDuration);
        return this.lastActivationTime ? Math.min(deviceRemaining, software) : deviceRemaining;
    }
}

module.exports = ValveAccessory;
