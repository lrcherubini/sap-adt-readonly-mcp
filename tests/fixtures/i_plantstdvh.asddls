* I_PLANTSTDVH (DDLS/DF) -- package MM_IM_VDM_MD
* read live from DEV client 001 on 2026-09-08 via adt_read_source

@AbapCatalog: {
                sqlViewName: 'IPLANTSTDVH',
                preserveKey: true,
                compiler.compareFilter: true,
                buffering: {
                             status: #ACTIVE,
                             type: #GENERIC,
                             numberOfKeyFields: 001
                           }
              }
@EndUserText.label: 'Plant'
@AccessControl: {
                  authorizationCheck: #NOT_REQUIRED,
                  personalData.blocking: #NOT_REQUIRED
                }
@ObjectModel: {
                usageType: {
                             sizeCategory: #S,
                             serviceQuality: #A,
                             dataClass:#CUSTOMIZING
                           },
                dataCategory: #VALUE_HELP,
                representativeKey: 'Plant',
                supportedCapabilities: [#VALUE_HELP_PROVIDER]
              }
@VDM: {
        viewType: #BASIC,
        lifecycle.contract.type: #PUBLIC_LOCAL_API
      }
@ClientHandling.algorithm: #SESSION_VARIABLE
@Analytics.dataCategory: #DIMENSION
@Search.searchable: true
@Consumption.ranked: true
@Metadata: {
             allowExtensions: true,
             ignorePropagatedAnnotations: true
           }

define view I_PlantStdVH
  as select from t001w
{
      @ObjectModel.text.element: 'PlantName'
      @Search.defaultSearchElement: true
      @Search.fuzzinessThreshold: 0.8
      @Search.ranking: #HIGH
  key werks                     as Plant,
      @Semantics.text: true
      @Search.defaultSearchElement: true
      @Search.fuzzinessThreshold: 0.8
      @Search.ranking: #LOW
      cast(name1 as werks_name) as PlantName
}
