// Synthetic parameter list, shaped like a real checkout: five value-help edges, one of
// them with an additionalBinding.
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Product Review'
@Search.searchable: true
@Metadata.allowExtensions:true
@Metadata.ignorePropagatedAnnotations: true
define view entity ZC_DemoItemRating
  with parameters
    @EndUserText.label: 'Plant'
    @Consumption.valueHelpDefinition: [{
      entity: { name: 'I_Plant', element: 'Plant' }
    }]
    P_Plant           : werks_d,

    @EndUserText.label: 'Storage Location'
    @Consumption.valueHelpDefinition: [{
      entity: { name: 'I_StorageLocation', element: 'StorageLocation' },
      additionalBinding: [
        { localElement: 'P_Plant', element: 'Plant', usage: #FILTER_AND_RESULT }
      ]
    }]
    P_StorageLocation : lgort_d,

    @EndUserText.label: 'Sales Organization'
    @Consumption.valueHelpDefinition: [{
      entity: { name: 'I_SalesOrganization', element: 'SalesOrganization' }
    }]
    P_SalesOrg        : vkorg,

    @EndUserText.label: 'Distribution Channel'
    @Consumption.valueHelpDefinition: [{
      entity: { name: 'I_DistributionChannel', element: 'DistributionChannel' }
    }]
    P_DistChannel     : vtweg,

    @EndUserText.label: 'MRP Area'
    @Consumption.valueHelpDefinition: [{
      entity: { name: 'I_MRPArea', element: 'MRPArea' }
    }]
    P_MRPArea         : berid
  as select from ZI_DemoItemRating {}
