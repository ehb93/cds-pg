const [,major,minor] = /v(\d+)\.(\d+)/.exec(process.version)
const production = process.env.NODE_ENV === 'production'

module.exports = {

  requires: require('./requires'),

  features: {
    cls: major > 12 || major == 12 && minor >= 18,
    live_reload: !production,
    fiori_preview: !production,
    fiori_routes: !production,
    in_memory_db: !production,
    test_data: !production,
    test_mocks: !production,
    mocked_bindings: !production,
    // skip_unused: 'all',
    skip_unused: true,
    one_model: true,
    localized: true,
    // assert_integrity: true,
    cds_tx_protection: true,
    cds_tx_inheritance: true,
  },

  log: {
    Logger: undefined, //> use default
    levels: {
      compile: 'warn',
      cli: 'warn',
      deploy: 'info',
      serve:  'info',
      server: 'info',
    },
    service: false,
    // adds custom fields in kibana's error rendering (unknown fields are ignored); key: index
    kibana_custom_fields: {
      // sql
      query: 0,
      // generic validations
      target: 1,
      details: 2
    }
  },

  folders: { // IMPORTANT: order is significant for cds.load('*')
    db: 'db/',
    srv: 'srv/',
    app: 'app/',
  },

  i18n: {
    folders: ['_i18n', 'i18n', 'assets/i18n'],
    for_sqlite: ['de', 'fr'],
    for_sql: ['de', 'fr'],
    languages: 'all', // or array.  'all': whatever language files are found next to models
    default_language: 'en',
    preserved_locales: [
      // IMPORTANT: Never, never modify this list, as that would break existing projects !!!!
      // Projects can and have to override if they want something different.
      'en_GB',
      'es_CO',
      'es_MX',
      'fr_CA',
      'pt_PT',
      'zh_CN',
      'zh_HK',
      'zh_TW'
    ]
  },

  odata: {
    flavors: {
      v2: {
        version: 'v2',
        // containment:false,
        // structs:false,
        // refs:false, //> proxies:false,
      },
      v4: {
        version: 'v4',
        // containment:false,
        // structs:false,
        // refs:false, //> proxies:false,
      },
      w4: { // for ODM with Fiori clients
        version: 'v4',
        containment:true,
        structs:true,
        refs:false, //> proxies:false,
        xrefs:false,
      },
      x4: { // for A2X APIs
        version: 'v4',
        containment:true,
        structs:true,
        refs:true, //> proxies:true,
        xrefs:true,
      },
    },
    version: 'v4', // following is to support code completion only...
    structs: undefined,
    refs: undefined,
    proxies: undefined,
    containment: undefined,
  },

  sql: {
    names: 'plain', // or 'quoted', or 'hdbcds'
    dialect: 'sqlite' // or 'plain' or 'hana'
  },

  hana: {
    'deploy-format': 'hdbcds', // or 'hdbtable'
    journal:  {
      'change-mode': 'alter'
    }
  },

  build: {
    target: 'gen'
  },

  mtx: {
    api: {
      model: true,
      provisioning: true,
      metadata: true,
      diagnose: true
    },
    domain: '__default__'
  },

  cdsc: {
    // cv2: {
    //   _localized_entries: true,
    //   _texts_entries: true,
    // }
    // toSql: { associations: 'joins' },
    // newCsn: true,
  },

  query: {
    limit: {
      max: 1000
    }
  },

}
