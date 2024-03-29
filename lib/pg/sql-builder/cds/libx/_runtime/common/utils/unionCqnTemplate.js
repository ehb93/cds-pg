module.exports = {
  SET: {
    op: 'union',
    all: true,
    args: [
      {
        SELECT: {
          from: {
            join: 'inner',
            args: [
              {
                ref: ['%%DRAFT%%']
              },
              {
                ref: ['DRAFT.DraftAdministrativeData'],
                as: 'filterAdmin'
              }
            ],
            on: [
              {
                ref: ['%%DRAFT%%', 'DraftAdministrativeData_DraftUUID']
              },
              '=',
              {
                ref: ['filterAdmin', 'DraftUUID']
              }
            ]
          },
          where: [
            {
              ref: ['filterAdmin', 'InProcessByUser']
            },
            '=',
            {
              val: '%%USER%%'
            }
          ],
          columns: [
            '%%DRAFT_COLUMNS%%',
            {
              ref: ['IsActiveEntity'],
              cast: {
                type: 'cds.Boolean'
              }
            },
            {
              ref: ['HasActiveEntity'],
              cast: {
                type: 'cds.Boolean'
              }
            },
            {
              ref: ['HasDraftEntity'],
              cast: {
                type: 'cds.Boolean'
              }
            },
            {
              ref: ['DraftAdministrativeData_DraftUUID']
            }
          ]
        }
      },
      {
        SELECT: {
          from: {
            ref: ['%%ACTIVE%%']
          },
          columns: [
            '%%ACTIVE_COLUMNS%%',
            {
              val: true,
              as: 'IsActiveEntity',
              cast: {
                type: 'cds.Boolean'
              }
            },
            {
              val: false,
              as: 'HasActiveEntity',
              cast: {
                type: 'cds.Boolean'
              }
            },
            {
              xpr: [
                'case',
                'when',
                {
                  SELECT: {
                    from: {
                      ref: ['%%DRAFT%%']
                    },
                    columns: [
                      {
                        val: 1
                      }
                    ],
                    where: ['(', '%%KEYS%%', ')']
                  },
                  as: 'HasDraftEntity',
                  cast: {
                    type: 'cds.Boolean'
                  }
                },
                'IS NOT NULL',
                'then',
                'true',
                'else',
                'false',
                'end'
              ],
              as: 'HasDraftEntity',
              cast: {
                type: 'cds.Boolean'
              }
            },
            {
              SELECT: {
                from: {
                  ref: ['%%DRAFT%%']
                },
                columns: [
                  {
                    ref: ['DraftAdministrativeData_DraftUUID']
                  }
                ],
                where: ['(', '%%KEYS%%', ')']
              }
            }
          ],
          where: [
            'not exists',
            {
              SELECT: {
                from: {
                  join: 'inner',
                  args: [
                    {
                      ref: ['%%DRAFT%%']
                    },
                    {
                      ref: ['DRAFT.DraftAdministrativeData'],
                      as: 'filterAdmin'
                    }
                  ],
                  on: [
                    {
                      ref: ['%%DRAFT%%', 'DraftAdministrativeData_DraftUUID']
                    },
                    '=',
                    {
                      ref: ['filterAdmin', 'DraftUUID']
                    }
                  ]
                },
                columns: [
                  {
                    val: 1
                  }
                ],
                where: [
                  '(',
                  {
                    ref: ['filterAdmin', 'InProcessByUser']
                  },
                  '=',
                  {
                    val: '%%USER%%'
                  },
                  ')',
                  'and',
                  '(',
                  '%%KEYS%%',
                  ')'
                ]
              }
            }
          ]
        }
      }
    ]
  }
}
