const FILTER_NAMESPACE = '편집필터';

module.exports = {
    name: 'edit-filter-namespace',
    type: 'code',
    code: async () => {
        const current = global.serverConfig.namespaces ?? [];
        if(!current.includes(FILTER_NAMESPACE)) {
            global.serverConfig.namespaces = [...current, FILTER_NAMESPACE];
        }
    }
};
