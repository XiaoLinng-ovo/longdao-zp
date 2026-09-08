<script setup lang="ts">
import { listOffers } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import OfferTable from '../components/OfferTable.vue'

const rows = listOffers()
</script>

<template>
  <PageHeader title="Offer 管理" description="追踪 Offer 审批、发送与候选人响应" />
  <OfferTable :rows="rows" />
</template>
