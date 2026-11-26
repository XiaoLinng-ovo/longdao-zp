<script setup lang="ts">
import { useRouter } from 'vue-router'
const router = useRouter()
</script>

<template>
  <main class="access-page" role="main">
    <section class="access-card" aria-labelledby="forbidden-title">
      <div class="access-code">403</div>
      <h1 id="forbidden-title">暂时没有访问权限</h1>
      <p>当前账号无法访问此页面。如需开通权限，请联系系统管理员。</p>
      <button class="btn btn-primary" type="button" @click="router.replace('/')">返回招聘工作台</button>
    </section>
  </main>
</template>

<style scoped>
.access-page{min-height:100vh;display:grid;place-items:center;padding:24px;background:#f8fafc}
.access-card{width:min(100%,460px);padding:42px 38px;text-align:center;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 15px 40px rgba(15,23,42,.08)}
.access-code{font-size:48px;font-weight:750;letter-spacing:2px;color:#dc2626}
h1{margin:10px 0 8px;font-size:22px;color:#1e293b}p{margin:0 0 24px;color:#64748b;font-size:13px;line-height:1.7}.btn{border:1px solid transparent;border-radius:7px;padding:9px 16px;font-size:13px;cursor:pointer}.btn-primary{background:#2563eb;color:#fff}.btn-primary:hover{background:#1d4ed8}
</style>
