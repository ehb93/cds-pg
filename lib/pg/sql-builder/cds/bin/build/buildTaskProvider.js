/* eslint-disable no-unused-vars */
module.exports = class BuildTaskProvider {
    constructor() {
        //injected by framework
        this._plugin = null 
    }
    canHandleTask(task) {
        // return this._plugin.provides.includes(task.for || task.use && this._getTaskId(task.use))
    }
    loadHandler(task) {
        // return module.require(`${this._plugin.path}/${task.for || this._getTaskId(task.use)}`)
    }
    async lookupTasks() {
        return []
    }
    async applyTaskDefaults(task) {
        // task.for = task.for || this._getTaskId(task.use)
    }
    _getTaskId(use) {
        if (this._plugin && this._plugin.id) {
            return use.substring(this._plugin.id.length + 1)
        }
    }
}
