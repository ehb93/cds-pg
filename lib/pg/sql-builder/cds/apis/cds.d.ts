declare type cds_facade =
import ('./core')
& import ('./models')
& import ('./connect')
& import ('./serve')
& import ('./ql').cds_ql
& import ('./services').cds_facade
& import ('./services').QueryAPI

declare global {
	const cds : cds_facade
	class SELECT<T> extends cds.ql.SELECT<T>{}
	class INSERT<T> extends cds.ql.INSERT<T>{}
	class UPDATE<T> extends cds.ql.UPDATE<T>{}
	class DELETE<T> extends cds.ql.DELETE<T>{}
	class CREATE<T> extends cds.ql.CREATE<T>{}
	class DROP<T> extends cds.ql.DROP<T>{}
}

export = cds
