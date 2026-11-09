* I_PLANTVH (DDLS/DF) -- package ODATA_MM_IM
* read live from DEV client 001 on 2026-09-08 via adt_read_source
* Kept verbatim: the commented-out annotations are the point of this fixture.

//@AbapCatalog:{
//               sqlViewName: 'IPLANTVH',
//               preserveKey: true,
//               compiler.compareFilter: true
//             }
@EndUserText.label: 'Plants'
@ObjectModel:{
               usageType:{
                           sizeCategory: #S,
                           serviceQuality: #A,
                           dataClass:#CUSTOMIZING
                         },
               dataCategory: #VALUE_HELP,
               representativeKey: 'Plant',
               modelingPattern: #ANALYTICAL_DIMENSION,
               supportedCapabilities: [#ANALYTICAL_DIMENSION, #CDS_MODELING_ASSOCIATION_TARGET, #SQL_DATA_SOURCE, #CDS_MODELING_DATA_SOURCE]
             }
@AccessControl:{
                 authorizationCheck: #NOT_REQUIRED,
                 personalData.blocking: #NOT_REQUIRED
               }
@VDM:{
     viewType: #COMPOSITE
     }
//@ClientHandling.algorithm: #SESSION_VARIABLE
@Analytics:{
             dataCategory: #DIMENSION,
             internalName: #LOCAL,
             technicalName: 'IPLANTEXTVH'
           }
@Search.searchable: true
@Consumption.ranked: true

@Metadata:{
            allowExtensions: true,
            ignorePropagatedAnnotations: true
          }
define view entity I_PlantVH
  as select from I_Plant
{

//    @ObjectModel.text.element: 'PlantName'
      @ObjectModel.text.element: ['PlantName']
      @Search.defaultSearchElement: true
      @Search.fuzzinessThreshold: 0.8
      @Search.ranking: #HIGH
  key Plant,
      @Semantics.text: true
      @Search.defaultSearchElement: true
      @Search.fuzzinessThreshold: 0.8
      @Search.ranking: #HIGH
      PlantName,
      ValuationArea,
      @ObjectModel.foreignKey.association: '_Customer'
      @Consumption.valueHelpDefinition: [
        { entity:  { name:    'I_Customer_VH',
                     element: 'Customer' }
        }]
      @Search.defaultSearchElement: true
      @Search.fuzzinessThreshold: 0.7
      @Search.ranking: #LOW
      cast(PlantCustomer as mmim_kunnr preserving type )                 as PlantCustomer,
      @ObjectModel.foreignKey.association: '_Supplier'
      @Consumption.valueHelpDefinition: [
        { entity:  { name:    'I_Supplier_VH',
                     element: 'Supplier' }
        }]
      @Search.defaultSearchElement: true
      @Search.fuzzinessThreshold: 0.7
      @Search.ranking: #LOW
      cast(PlantSupplier as mmim_lifnr preserving type )                 as PlantSupplier,
      FactoryCalendar,
      cast(DefaultPurchasingOrganization as mmim_ekorg preserving type ) as DefaultPurchasingOrganization,
      SalesOrganization,
      @ObjectModel.foreignKey.association: '_Address'
      AddressID,
      cast(PlantCategory as mmim_vlfkz preserving type )                 as PlantCategory,
      cast(DistributionChannel as mmim_vtwiv preserving type )           as DistributionChannel,
      cast(Division as mmim_spaiv preserving type )                      as Division,

//    Language,
//    IsMarkedForArchiving,
      _Address,
      _Customer,
      _Supplier,
      _ResponsiblePurchaseOrg,
      _PlantCategoryText
}
